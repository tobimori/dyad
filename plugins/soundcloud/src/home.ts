import { ProviderShelf, ProviderTrack } from "@dyad/plugin";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { api, fullStream, requestApi, Track, trackSource } from "./api.ts";
import type { clientIdCache } from "./api.ts";

const Chart = Schema.Struct({ collection: Schema.Array(Schema.Struct({ track: Track })) });

/** The trending tracks of all genres that play in full without an account */
export const readTrending = Effect.fn("readTrending")(function* (
  withClientId: Effect.Success<typeof clientIdCache>,
) {
  // `kind=top` gives 404 (October 2026)
  const request = HttpClientRequest.get(`${api}/charts`).pipe(
    HttpClientRequest.setUrlParams({
      kind: "trending",
      genre: "soundcloud:genres:all-music",
      limit: 25,
    }),
  );
  const chart = yield* requestApi(withClientId, request, Chart);

  const tracks = chart.collection.flatMap(({ track }) =>
    fullStream(track) === undefined
      ? []
      : [
          new ProviderTrack({
            disc: null,
            number: null,
            source: trackSource(track),
            streamable: true,
          }),
        ],
  );
  return [new ProviderShelf({ title: "Trending", tracks, releases: [] })];
});
