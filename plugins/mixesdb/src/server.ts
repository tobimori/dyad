import { Plugin } from "@dyad/plugin";
import type { ProviderTracklist } from "@dyad/plugin";
import { makePacer } from "@dyad/plugin/http";
import { Clock, Effect } from "effect";
import { HttpClient } from "effect/http";

import { setTracklists } from "./mixesdb.ts";

// Pages change slowly. A set without a page is asked again after some days, when someone can
// have added it.
const foundLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const missingLifetimeMs = 3 * 24 * 60 * 60 * 1000;

/** Tracklists of DJ sets from the MixesDB wiki, for the sources of other providers */
export const mixesdbPlugin = new Plugin({
  id: "dyad.mixesdb",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      // `robots.txt` asks for 4 seconds between requests (October 2026)
      const pace = yield* makePacer(4000);
      const cache = new Map<
        string,
        { readonly until: number; readonly tracklists: ReadonlyArray<ProviderTracklist> }
      >();

      yield* context.tracklists.add("mixesdb", (set) =>
        Effect.gen(function* () {
          const key = JSON.stringify([set.artists, set.title, set.durationMs]);
          const now = yield* Clock.currentTimeMillis;
          const cached = cache.get(key);
          if (cached !== undefined && cached.until > now) return cached.tracklists;

          const tracklists = yield* setTracklists(pace, set).pipe(Effect.provide(services));
          const lifetime = tracklists.length === 0 ? missingLifetimeMs : foundLifetimeMs;
          cache.set(key, { until: now + lifetime, tracklists });
          return tracklists;
        }),
      );
    }),
});
