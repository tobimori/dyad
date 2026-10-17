import { Plugin, Provider } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { clientIdCache, provider, resolveTrack, searchTracks } from "./api.ts";

/**
 * Searches SoundCloud and plays the tracks that play in full without an account. The plugin uses
 * the `client_id` of the SoundCloud web client.
 */
export const soundcloudPlugin = new Plugin({
  id: "dyad.soundcloud",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      const withClientId = yield* clientIdCache;

      yield* context.provider.add(
        provider,
        new Provider({
          name: "SoundCloud",
          resolve: (externalId) =>
            resolveTrack(withClientId, externalId).pipe(Effect.provide(services)),
          search: (query) => searchTracks(withClientId, query).pipe(Effect.provide(services)),
        }),
      );
    }),
});
