import { Plugin } from "@dyad/plugin";
import { Effect, Layer } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { ClientIds, clientIdsLayer, provider, resolveTrack, searchTracks } from "./api.ts";

/**
 * Searches SoundCloud and plays the tracks that play in full without an account. The plugin uses
 * the `client_id` of the SoundCloud web client and ignores the credentials.
 */
export const soundcloudPlugin = new Plugin({
  id: "dyad.soundcloud",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient | ClientIds>();

      yield* context.resolver.add(provider, (externalId) =>
        resolveTrack(externalId).pipe(Effect.provide(services)),
      );

      yield* context.search.add(provider, (query) =>
        searchTracks(query).pipe(Effect.provide(services)),
      );
    }).pipe(Effect.provide(clientIdsLayer.pipe(Layer.provideMerge(FetchHttpClient.layer)))),
});
