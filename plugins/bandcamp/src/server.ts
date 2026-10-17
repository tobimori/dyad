import { Plugin, Provider } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { provider, resolveTrack, searchTracks } from "./api.ts";

/**
 * Searches the public Bandcamp catalog and plays the public 128 kbps MP3 streams. Bandcamp needs
 * no account for this.
 */
export const bandcampPlugin = new Plugin({
  id: "dyad.bandcamp",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();

      yield* context.provider.add(
        provider,
        new Provider({
          name: "Bandcamp",
          resolve: (externalId) => resolveTrack(externalId).pipe(Effect.provide(services)),
          search: (query) => searchTracks(query).pipe(Effect.provide(services)),
        }),
      );
    }),
});
