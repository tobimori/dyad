import { ProviderAudio, ProviderSource, ResolveError, SearchError } from "@dyad/plugin";
import { Context, Data, Duration, Effect, Exit, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { readSegments, segmentBytes } from "./hls.ts";

export const provider = "soundcloud";

const userAgent = "Dyad (https://github.com/tobimori/dyad)";

const webUrl = "https://soundcloud.com";
const api = "https://api-v2.soundcloud.com";

/** `reason` goes into logs, so it never contains signed URLs or the `client_id` */
export class SoundCloudError extends Data.TaggedError("SoundCloudError")<{
  readonly reason: string;
}> {}

// SoundCloud answered 401 or 403. It replaces the `client_id` of its web client from time to time.
class ClientIdRejected extends Data.TaggedError("ClientIdRejected")<{
  readonly reason: string;
}> {}

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
  user: Schema.Struct({ username: Schema.String }),
  // Label releases have publisher metadata. Most uploads of users have none.
  publisher_metadata: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        artist: Schema.optional(Schema.String),
        isrc: Schema.optional(Schema.String),
      }),
    ),
  ),
  media: Schema.Struct({ transcodings: Schema.Array(Transcoding) }),
}) {}

const SearchResults = Schema.Struct({ collection: Schema.Array(Track) });

const StreamUrl = Schema.Struct({ url: Schema.String });

// The numeric track ID stays the same when the uploader renames the track or the permalink
const ExternalId = Schema.String.check(Schema.isPattern(/^\d+$/));

const client = Effect.map(HttpClient.HttpClient, (httpClient) =>
  httpClient.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", userAgent))),
);

// The web client has its `client_id` in one of its script bundles, usually in the last one
const scrapeClientId = Effect.gen(function* () {
  const httpClient = HttpClient.filterStatusOk(yield* client);
  const homepage = yield* httpClient.get(webUrl);
  const html = yield* homepage.text;

  const scripts = html.match(/https:\/\/a-v2\.sndcdn\.com\/assets\/[^"]+\.js/g) ?? [];

  for (const script of scripts.toReversed()) {
    const response = yield* httpClient.get(script);
    const javascript = yield* response.text;

    const clientId = javascript.match(/client_id\s*:\s*"([0-9a-zA-Z]{32})"/)?.[1];
    if (clientId !== undefined) return Redacted.make(clientId);
  }

  return yield* new SoundCloudError({ reason: "Web client ID not found" });
}).pipe(
  Effect.catchTag("HttpClientError", () =>
    Effect.fail(new SoundCloudError({ reason: "Cannot read the web client" })),
  ),
);

// Failures are not cached, so the next request tries again
const keepSuccess = (exit: Exit.Exit<unknown, unknown>) =>
  Exit.isSuccess(exit) ? Duration.infinity : Duration.zero;

const makeClientIds = Effect.gen(function* () {
  const [current, invalidate] = yield* Effect.cachedInvalidateWithTTL(scrapeClientId, keepSuccess);
  return { current, invalidate };
});

/**
 * Keeps the `client_id` of the SoundCloud web client in memory, because it costs up to ten
 * requests
 */
export class ClientIds extends Context.Service<ClientIds, Effect.Success<typeof makeClientIds>>()(
  "@dyad/plugin-soundcloud/ClientIds",
) {}

export const clientIdsLayer = Layer.effect(ClientIds, makeClientIds);

// HTTP errors contain the request URL, with the `client_id` or a signed URL
const requestWithClientId = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  clientId: Redacted.Redacted<string>,
  schema: S,
) =>
  Effect.gen(function* () {
    const httpClient = yield* client;
    const response = yield* httpClient
      .execute(request.pipe(HttpClientRequest.setUrlParam("client_id", Redacted.value(clientId))))
      .pipe(Effect.mapError(() => new SoundCloudError({ reason: "Request failed" })));

    const status = response.status;
    if (status === 401 || status === 403) {
      return yield* new ClientIdRejected({ reason: `SoundCloud answered status ${status}` });
    }
    if (status < 200 || status >= 300) {
      return yield* new SoundCloudError({ reason: `SoundCloud answered status ${status}` });
    }

    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new SoundCloudError({ reason: "Unexpected response" })),
    );
  });

// Sends the request once more with a new `client_id` when SoundCloud rejects the cached one
const requestApi = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const clientIds = yield* ClientIds;
    const send = Effect.flatMap(clientIds.current, (clientId) =>
      requestWithClientId(request, clientId, schema),
    );

    return yield* send.pipe(
      Effect.catchTag("ClientIdRejected", () => clientIds.invalidate.pipe(Effect.andThen(send))),
    );
  });

// SoundCloud gives MP3 only for the snippets of Go+ tracks (October 2026). A full stream without an
// account is HLS of fragmented MP4 with AAC. Many label releases have only `cbc-encrypted-hls` and
// `ctr-encrypted-hls`, which need DRM, so they have no full stream here.
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
export const searchTracks = (query: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${api}/search/tracks`).pipe(
      HttpClientRequest.setUrlParams({ q: query, limit: 30 }),
    );
    const response = yield* requestApi(request, SearchResults);

    return response.collection
      .filter((track) => fullStream(track) !== undefined)
      .map(
        (track) =>
          new ProviderSource({
            provider,
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
          }),
      );
  }).pipe(Effect.mapError((error) => new SearchError({ reason: error.reason })));

/** Streams the HLS AAC transcoding of a track as one fragmented MP4 file */
export const resolveTrack = (externalId: string) =>
  Effect.gen(function* () {
    const trackId = yield* Schema.decodeEffect(ExternalId)(externalId).pipe(
      Effect.mapError(() => new SoundCloudError({ reason: "Invalid track ID" })),
    );

    const track = yield* requestApi(HttpClientRequest.get(`${api}/tracks/${trackId}`), Track);

    const transcoding = fullStream(track);
    if (transcoding === undefined) {
      return yield* new SoundCloudError({
        reason: "The track does not play in full without an account",
      });
    }

    // The web client sends the track authorization with each stream request
    const streamRequest = HttpClientRequest.get(transcoding.url).pipe(
      HttpClientRequest.setUrlParam("track_authorization", track.track_authorization),
    );
    const stream = yield* requestApi(streamRequest, StreamUrl);

    const segments = yield* readSegments(stream.url).pipe(
      Effect.mapError(() => new SoundCloudError({ reason: "Cannot read the playlist" })),
    );
    if (segments.length === 0) {
      return yield* new SoundCloudError({ reason: "The playlist has no segments" });
    }

    const services = yield* Effect.context<HttpClient.HttpClient>();
    const bytes = segmentBytes(segments).pipe(
      // Errors contain the signed segment URL
      Stream.mapError(() => new ResolveError({ reason: "Cannot read an audio segment" })),
      Stream.provideContext(services),
    );
    return new ProviderAudio({ bytes });
  }).pipe(Effect.mapError((error) => new ResolveError({ reason: error.reason })));
