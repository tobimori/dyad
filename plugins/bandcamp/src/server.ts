import { Plugin } from "@dyad/plugin";
import { Effect } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { provider, resolveTrack, searchTracks } from "./api.ts";

/**
 * Searches the public Bandcamp catalog and plays the public 128 kbps MP3 streams. Bandcamp needs
 * no account for this, so the plugin ignores the credentials.
 */
export const bandcampPlugin = new Plugin({
  id: "dyad.bandcamp",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();

      yield* context.resolver.add(provider, (externalId) =>
        resolveTrack(externalId).pipe(Effect.provide(services)),
      );

      yield* context.search.add(provider, (query) =>
        searchTracks(query).pipe(Effect.provide(services)),
      );
    }).pipe(Effect.provide(FetchHttpClient.layer)),
});
