import { CreditedArtist, ProviderAudio, ProviderError, ProviderSource } from "@dyad/plugin";
import { getJson, HttpStatusError, send } from "@dyad/plugin/http";
import type { HttpRequestError } from "@dyad/plugin/http";
import { Effect, Schema, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

export const provider = "bandcamp";

// Public endpoints of the Bandcamp web search and the Bandcamp mobile app, without an account
const searchUrl = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
const detailsUrl = "https://bandcamp.com/api/mobile/25/tralbum_details";

class SearchTrack extends Schema.Class<SearchTrack>("SearchTrack")({
  id: Schema.Int,
  name: Schema.String,
  band_id: Schema.Int,
  band_name: Schema.String,
  album_name: Schema.NullOr(Schema.String),
  album_id: Schema.optional(Schema.NullOr(Schema.Int)),
  art_id: Schema.optional(Schema.NullOr(Schema.Int)),
}) {}

const SearchResults = Schema.Struct({
  auto: Schema.Struct({ results: Schema.Array(SearchTrack) }),
});

class DetailsTrack extends Schema.Class<DetailsTrack>("DetailsTrack")({
  track_id: Schema.Int,
  is_streamable: Schema.Boolean,
  /** Seconds */
  duration: Schema.optional(Schema.NullOr(Schema.Finite)),
  streaming_url: Schema.optional(
    Schema.NullOr(Schema.Struct({ "mp3-128": Schema.optional(Schema.String) })),
  ),
}) {}

// Bandcamp answers status 200 with an error object, for example for a deleted track
const Details = Schema.Union([
  Schema.Struct({ tracks: Schema.Array(DetailsTrack) }),
  Schema.Struct({ error: Schema.Literal(true), error_message: Schema.String }),
]);

// The mobile app sends the band ID with each track ID
const ExternalId = Schema.TemplateLiteralParser([Schema.Int, "-", Schema.Int]);

const toProviderError = (error: HttpStatusError | HttpRequestError) =>
  new ProviderError({
    reason:
      error instanceof HttpStatusError ? `Bandcamp answered status ${error.status}` : error.reason,
  });

// The core gives a provider search 8 seconds in total
const durationTimeout = "4 seconds";

const fetchDetails = (bandId: number, type: "a" | "t", id: number) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(detailsUrl).pipe(
      HttpClientRequest.setUrlParams({ band_id: bandId, tralbum_type: type, tralbum_id: id }),
    );
    const details = yield* getJson(request, Details).pipe(Effect.mapError(toProviderError));
    if ("error" in details) {
      return yield* new ProviderError({ reason: `Bandcamp: ${details.error_message}` });
    }
    return details.tracks;
  });

export const searchTracks = (query: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(searchUrl).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        search_text: query,
        search_filter: "t",
        full_page: false,
        fan_id: null,
      }),
    );
    const response = yield* getJson(request, SearchResults).pipe(Effect.mapError(toProviderError));

    // One request per release gives the durations of all its tracks. A single has no album.
    const releases = new Map(
      response.auto.results.map((track) => {
        const release =
          track.album_id === undefined || track.album_id === null
            ? { bandId: track.band_id, type: "t" as const, id: track.id }
            : { bandId: track.band_id, type: "a" as const, id: track.album_id };
        return [`${release.bandId}-${release.type}-${release.id}`, release];
      }),
    );
    // A timeout keeps the durations that arrived
    const durations = new Map<number, number>();
    yield* Effect.forEach(
      releases.values(),
      (release) =>
        fetchDetails(release.bandId, release.type, release.id).pipe(
          Effect.tap((tracks) =>
            Effect.sync(() => {
              for (const track of tracks) {
                if (track.duration !== undefined && track.duration !== null) {
                  durations.set(track.track_id, Math.round(track.duration * 1000));
                }
              }
            }),
          ),
          Effect.ignore,
        ),
      { concurrency: 4, discard: true },
    ).pipe(Effect.timeout(durationTimeout), Effect.ignore);

    return response.auto.results.map(
      (track) =>
        new ProviderSource({
          externalId: `${track.band_id}-${track.id}`,
          title: track.name,
          artist: track.band_name,
          album: track.album_name,
          durationMs: durations.get(track.id) ?? null,
          isrc: null,
          container: "mp3",
          codec: "mp3",
          lossless: false,
          encrypted: false,
          // Image format `_10` is the full-size JPEG of the release art
          artworkUrl:
            track.art_id === undefined || track.art_id === null
              ? null
              : `https://f4.bcbits.com/img/a${track.art_id}_10.jpg`,
          artists: [new CreditedArtist({ id: String(track.band_id), name: track.band_name })],
          explicit: null,
          bitrate: 128_000,
        }),
    );
  });

/** Streams the public 128 kbps MP3 of a track */
export const resolveTrack = (externalId: string) =>
  Effect.gen(function* () {
    const [bandId, , trackId] = yield* Schema.decodeUnknownEffect(ExternalId)(externalId).pipe(
      Effect.mapError(() => new ProviderError({ reason: "Invalid track ID" })),
    );

    const tracks = yield* fetchDetails(bandId, "t", trackId);
    const track = tracks.find((item) => item.track_id === trackId);
    if (track === undefined) {
      return yield* new ProviderError({ reason: "Bandcamp did not return the track" });
    }

    const streamUrl = track.streaming_url?.["mp3-128"];
    if (!track.is_streamable || streamUrl === undefined) {
      return yield* new ProviderError({
        reason: "The artist does not allow streams of this track",
      });
    }

    // Open the stream here, so that a failure occurs before the core starts its response
    const response = yield* send(HttpClientRequest.get(streamUrl)).pipe(
      Effect.mapError(toProviderError),
    );

    // Errors contain the signed stream URL
    const bytes = response.stream.pipe(
      Stream.mapError(() => new ProviderError({ reason: "Cannot read the audio stream" })),
    );
    return new ProviderAudio({ bytes });
  });
