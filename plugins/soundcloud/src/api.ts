import { CreditedArtist, ProviderAudio, ProviderError, ProviderSource } from "@dyad/plugin";
import { getJson, getText, makeScrapedToken } from "@dyad/plugin/http";
import { Duration, Effect, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { readSegments, segmentBytes } from "./hls.ts";

export const provider = "soundcloud";

const webUrl = "https://soundcloud.com";
const api = "https://api-v2.soundcloud.com";

class Transcoding extends Schema.Class<Transcoding>("Transcoding")({
  // Answers with the signed playlist URL
  url: Schema.String,
  preset: Schema.String,
  snipped: Schema.Boolean,
  format: Schema.Struct({ protocol: Schema.String }),
}) {}

class Track extends Schema.Class<Track>("Track")({
  id: Schema.Int,
  title: Schema.String,
  duration: Schema.Int,
  policy: Schema.String,
  track_authorization: Schema.String,
  user: Schema.Struct({ id: Schema.Int, username: Schema.String }),
  artwork_url: Schema.optional(Schema.NullOr(Schema.String)),
  // Label releases have publisher metadata. Most uploads of users have none.
  publisher_metadata: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        artist: Schema.optional(Schema.String),
        isrc: Schema.optional(Schema.String),
        explicit: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
  media: Schema.Struct({ transcodings: Schema.Array(Transcoding) }),
}) {}

const SearchResults = Schema.Struct({ collection: Schema.Array(Track) });

const StreamUrl = Schema.Struct({ url: Schema.String });

// The numeric track ID stays the same when the uploader renames the track or the permalink
const ExternalId = Schema.String.check(Schema.isPattern(/^\d+$/));

// The web client has its `client_id` in one of its script bundles, usually in the last one
const scrapeClientId = Effect.gen(function* () {
  const html = yield* getText(HttpClientRequest.get(webUrl));
  const scripts = html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g) ?? [];

  for (const script of scripts.toReversed()) {
    const javascript = yield* getText(HttpClientRequest.get(script));

    const clientId = javascript.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/)?.[1];
    if (clientId !== undefined) return Redacted.make(clientId);
  }

  return yield* new ProviderError({ reason: "Web client ID not found" });
}).pipe(
  Effect.catchTags({
    HttpStatusError: () => Effect.fail(new ProviderError({ reason: "Cannot read the web client" })),
    HttpRequestError: () =>
      Effect.fail(new ProviderError({ reason: "Cannot read the web client" })),
  }),
);

/**
 * The `client_id` of the SoundCloud web client. It costs up to ten requests, so it stays in memory
 * until SoundCloud rejects it with 401 or 403, which it does when it replaces the web client.
 */
export const clientIdCache = makeScrapedToken(scrapeClientId, {
  timeToLive: Duration.infinity,
  rejectedStatuses: [401, 403],
});

const requestApi = <S extends Schema.Constraint>(
  withClientId: Effect.Success<typeof clientIdCache>,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  withClientId((clientId) =>
    getJson(
      request.pipe(HttpClientRequest.setUrlParam("client_id", Redacted.value(clientId))),
      schema,
    ),
  ).pipe(
    Effect.catchTags({
      HttpStatusError: (error) =>
        Effect.fail(new ProviderError({ reason: `SoundCloud answered status ${error.status}` })),
      HttpRequestError: (error) => Effect.fail(new ProviderError({ reason: error.reason })),
    }),
  );

// SoundCloud (October 2026) gives MP3 only for Go+ snippets. A full stream without an account is
// HLS of fragmented MP4 AAC. `cbc-encrypted-hls` and `ctr-encrypted-hls` need DRM and are skipped.
const fullStream = (track: Track) => {
  if (track.policy === "SNIP" || track.policy === "BLOCK") return undefined;

  const transcodings = track.media.transcodings.filter(
    (transcoding) => transcoding.format.protocol === "hls" && !transcoding.snipped,
  );

  return (
    transcodings.find((transcoding) => transcoding.preset === "aac_160k") ??
    transcodings.find((transcoding) => transcoding.preset === "aac_96k")
  );
};

/** Tracks that play in full without an account, in SoundCloud's order of relevance */
export const searchTracks = (withClientId: Effect.Success<typeof clientIdCache>, query: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${api}/search/tracks`).pipe(
      HttpClientRequest.setUrlParams({ q: query, limit: 30 }),
    );
    const response = yield* requestApi(withClientId, request, SearchResults);

    return response.collection
      .filter((track) => fullStream(track) !== undefined)
      .map(
        (track) =>
          new ProviderSource({
            externalId: String(track.id),
            title: track.title,
            artist: track.publisher_metadata?.artist ?? track.user.username,
            album: null,
            durationMs: track.duration,
            isrc: track.publisher_metadata?.isrc ?? null,
            container: "mov",
            codec: "aac",
            lossless: false,
            encrypted: false,
            // The API gives the 100 pixel `-large` variant; `-t500x500` is the same image larger
            artworkUrl: track.artwork_url?.replace("-large.", "-t500x500.") ?? null,
            // The uploader is the artist only when the label metadata names no other artist
            artists:
              track.publisher_metadata?.artist === undefined
                ? [new CreditedArtist({ id: String(track.user.id), name: track.user.username })]
                : [],
            explicit: track.publisher_metadata?.explicit ?? null,
          }),
      );
  });

/** Streams the HLS AAC transcoding of a track as one fragmented MP4 file */
export const resolveTrack = (
  withClientId: Effect.Success<typeof clientIdCache>,
  externalId: string,
) =>
  Effect.gen(function* () {
    const trackId = yield* Schema.decodeEffect(ExternalId)(externalId).pipe(
      Effect.mapError(() => new ProviderError({ reason: "Invalid track ID" })),
    );

    const track = yield* requestApi(
      withClientId,
      HttpClientRequest.get(`${api}/tracks/${trackId}`),
      Track,
    );

    const transcoding = fullStream(track);
    if (transcoding === undefined) {
      return yield* new ProviderError({
        reason: "The track does not play in full without an account",
      });
    }

    // The web client sends the track authorization with each stream request
    const streamRequest = HttpClientRequest.get(transcoding.url).pipe(
      HttpClientRequest.setUrlParam("track_authorization", track.track_authorization),
    );
    const stream = yield* requestApi(withClientId, streamRequest, StreamUrl);

    const segments = yield* readSegments(stream.url).pipe(
      Effect.mapError(() => new ProviderError({ reason: "Cannot read the playlist" })),
    );
    if (segments.length === 0) {
      return yield* new ProviderError({ reason: "The playlist has no segments" });
    }

    const services = yield* Effect.context<HttpClient.HttpClient>();
    const read = (selected: typeof segments) =>
      segmentBytes(selected).pipe(
        // Errors contain the signed segment URL
        Stream.mapError(() => new ProviderError({ reason: "Cannot read an audio segment" })),
        Stream.provideContext(services),
      );
    return new ProviderAudio({
      bytes: read(segments),
      bytesFrom: (startMs) =>
        read(segments.filter((segment) => segment.endMs === null || segment.endMs > startMs)),
    });
  });
