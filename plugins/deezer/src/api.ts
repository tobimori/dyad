import { PopularityHit, ProviderError } from "@dyad/plugin";
import { getJson } from "@dyad/plugin/http";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

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
    const request = HttpClientRequest.get(searchUrl).pipe(
      HttpClientRequest.setUrlParams({ q: query, limit: resultLimit }),
    );
    const results = yield* getJson(request, SearchResults).pipe(
      Effect.catchTags({
        HttpStatusError: (error) =>
          Effect.fail(new ProviderError({ reason: `Deezer answered status ${error.status}` })),
        HttpRequestError: (error) => Effect.fail(new ProviderError({ reason: error.reason })),
      }),
    );
    if ("error" in results) {
      return yield* new ProviderError({ reason: `Deezer: ${results.error.message}` });
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
