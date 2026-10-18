import { Plugin, Provider } from "@dyad/plugin";
import { makePacer } from "@dyad/plugin/http";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { provider, readHome, resolveItem } from "./api.ts";

/**
 * The Popular and Latest charts of Hype Machine. Its tracks play through the Bandcamp and
 * SoundCloud providers.
 */
export const hypemPlugin = new Plugin({
  id: "dyad.hypem",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      // A home page asks for the link of each track. Hype Machine blocks clients that send too
      // many requests.
      const pace = yield* makePacer(100);

      yield* context.provider.add(
        provider,
        new Provider({
          name: "Hype Machine",
          resolve: (externalId) => resolveItem(externalId).pipe(Effect.provide(services)),
          home: () => readHome(pace).pipe(Effect.provide(services)),
        }),
      );
    }),
});
