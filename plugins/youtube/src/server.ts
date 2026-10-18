import { Plugin, Provider } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { provider, resolveVideo, videoTracklists, visitorCache } from "./api.ts";
import { searchMusic } from "./search.ts";

/**
 * Searches YouTube videos and plays their Opus audio without an account, for example DJ sets and
 * full albums. The plugin uses YouTube's internal API like the YouTube apps.
 */
export const youtubePlugin = new Plugin({
  id: "dyad.youtube",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      const withVisitor = yield* visitorCache;

      yield* context.provider.add(
        provider,
        new Provider({
          name: "YouTube",
          resolve: (externalId) =>
            resolveVideo(withVisitor, externalId).pipe(Effect.provide(services)),
          search: (query) => searchMusic(query).pipe(Effect.provide(services)),
          tracklists: (externalId) =>
            videoTracklists(withVisitor, externalId).pipe(Effect.provide(services)),
          uploads: true,
          download: { leaseDays: 30 },
        }),
      );
    }),
});
