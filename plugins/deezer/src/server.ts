import { Plugin } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { trackPopularity } from "./api.ts";

/** Search popularity from the public Deezer API. Deezer gives no playback here and needs no account. */
export const deezerPlugin = new Plugin({
  id: "dyad.deezer",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();

      yield* context.popularity.add("deezer", (query) =>
        trackPopularity(query).pipe(Effect.provide(services)),
      );
    }),
});
