import { ProviderAudio, ProviderSource, ResolveError, SearchError } from "@dyad/plugin";
import { Data, Effect, Schema, Stream } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const provider = "bandcamp";

const userAgent = "Dyad (https://github.com/tobimori/dyad)";

// Public endpoints of the Bandcamp web search and the Bandcamp mobile app, without an account
const searchUrl = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
const detailsUrl = "https://bandcamp.com/api/mobile/25/tralbum_details";

// `reason` goes into logs, so it never contains signed stream URLs
class BandcampError extends Data.TaggedError("BandcampError")<{
  readonly reason: string;
}> {}

class SearchTrack extends Schema.Class<SearchTrack>("SearchTrack")({
  id: Schema.Int,
  name: Schema.String,
  band_id: Schema.Int,
  band_name: Schema.String,
  album_name: Schema.NullOr(Schema.String),
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

const client = Effect.map(HttpClient.HttpClient, (httpClient) =>
  httpClient.pipe(HttpClient.mapRequest(HttpClientRequest.setHeader("User-Agent", userAgent))),
);

// HTTP errors contain the request URL, which can be a signed stream URL
const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const httpClient = yield* client;
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.mapError(() => new BandcampError({ reason: "Request failed" })));

    if (response.status < 200 || response.status >= 300) {
      return yield* new BandcampError({ reason: `Bandcamp answered status ${response.status}` });
    }
    return response;
  });

const requestJson = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const response = yield* send(request);

    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new BandcampError({ reason: "Unexpected response" })),
    );
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
    const response = yield* requestJson(request, SearchResults);

    return response.auto.results.map(
      (track) =>
        new ProviderSource({
          provider,
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
        }),
    );
  }).pipe(Effect.mapError((error) => new SearchError({ reason: error.reason })));

/** Streams the public 128 kbps MP3 of a track */
export const resolveTrack = (externalId: string) =>
  Effect.gen(function* () {
    const [bandId, , trackId] = yield* Schema.decodeUnknownEffect(ExternalId)(externalId).pipe(
      Effect.mapError(() => new BandcampError({ reason: "Invalid track ID" })),
    );

    const request = HttpClientRequest.get(detailsUrl).pipe(
      HttpClientRequest.setUrlParams({ band_id: bandId, tralbum_type: "t", tralbum_id: trackId }),
    );
    const details = yield* requestJson(request, Details);
    if ("error" in details) {
      return yield* new BandcampError({ reason: `Bandcamp: ${details.error_message}` });
    }

    const track = details.tracks.find((item) => item.track_id === trackId);
    if (track === undefined) {
      return yield* new BandcampError({ reason: "Bandcamp did not return the track" });
    }

    const streamUrl = track.streaming_url?.["mp3-128"];
    if (!track.is_streamable || streamUrl === undefined) {
      return yield* new BandcampError({
        reason: "The artist does not allow streams of this track",
      });
    }

    // Open the stream here, so that a failure occurs before the core starts its response
    const response = yield* send(HttpClientRequest.get(streamUrl));

    const bytes = response.stream.pipe(
      Stream.mapError(() => new ResolveError({ reason: "Cannot read the audio stream" })),
    );
    return new ProviderAudio({ bytes });
  }).pipe(Effect.mapError((error) => new ResolveError({ reason: error.reason })));
