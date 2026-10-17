import { ProviderAudio, ProviderError, ProviderSource } from "@dyad/plugin";
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
  art_id: Schema.optional(Schema.NullOr(Schema.Int)),
}) {}

const SearchResults = Schema.Struct({
  auto: Schema.Struct({ results: Schema.Array(SearchTrack) }),
});

class DetailsTrack extends Schema.Class<DetailsTrack>("DetailsTrack")({
  track_id: Schema.Int,
  is_streamable: Schema.Boolean,
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

    return response.auto.results.map(
      (track) =>
        new ProviderSource({
          externalId: `${track.band_id}-${track.id}`,
          title: track.name,
          artist: track.band_name,
          album: track.album_name,
          // The search gives no duration
          durationMs: null,
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
        }),
    );
  });

/** Streams the public 128 kbps MP3 of a track */
export const resolveTrack = (externalId: string) =>
  Effect.gen(function* () {
    const [bandId, , trackId] = yield* Schema.decodeUnknownEffect(ExternalId)(externalId).pipe(
      Effect.mapError(() => new ProviderError({ reason: "Invalid track ID" })),
    );

    const request = HttpClientRequest.get(detailsUrl).pipe(
      HttpClientRequest.setUrlParams({ band_id: bandId, tralbum_type: "t", tralbum_id: trackId }),
    );
    const details = yield* getJson(request, Details).pipe(Effect.mapError(toProviderError));
    if ("error" in details) {
      return yield* new ProviderError({ reason: `Bandcamp: ${details.error_message}` });
    }

    const track = details.tracks.find((item) => item.track_id === trackId);
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
