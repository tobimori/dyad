import { PopularityHit, SearchError } from "@dyad/plugin";
import { Effect, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// Public endpoint without a key
const searchUrl = "https://api.deezer.com/search/track";

// Enough to cover the results of the catalog providers
const resultLimit = 50;

// The most played tracks have a `rank` of almost 1,000,000
const maximumRank = 1_000_000;

class Track extends Schema.Class<Track>("Track")({
  title: Schema.String,
  isrc: Schema.optional(Schema.String),
  rank: Schema.Finite,
  artist: Schema.Struct({ name: Schema.String }),
}) {}

// Deezer answers status 200 with an error object, for example when the request quota is used
const SearchResults = Schema.Union([
  Schema.Struct({ data: Schema.Array(Track) }),
  Schema.Struct({ error: Schema.Struct({ message: Schema.String }) }),
]);

/** Deezer's global popularity of the tracks that match `query` */
export const trackPopularity = (query: string) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const request = HttpClientRequest.get(searchUrl).pipe(
      HttpClientRequest.setUrlParams({ q: query, limit: resultLimit }),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(Effect.mapError(() => new SearchError({ reason: "Request failed" })));

    if (response.status < 200 || response.status >= 300) {
      return yield* new SearchError({ reason: `Deezer answered status ${response.status}` });
    }

    const results = yield* HttpClientResponse.schemaBodyJson(SearchResults)(response).pipe(
      Effect.mapError(() => new SearchError({ reason: "Unexpected response" })),
    );
    if ("error" in results) {
      return yield* new SearchError({ reason: `Deezer: ${results.error.message}` });
    }

    return results.data.map(
      (track) =>
        new PopularityHit({
          title: track.title,
          artist: track.artist.name,
          isrc: track.isrc ?? null,
          popularity: Math.min(Math.max(track.rank / maximumRank, 0), 1),
        }),
    );
  });
