import { MusicBrainzError, MusicBrainzLookup, Plugin } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { Pacing, pacingLayer } from "./http.ts";
import { lookupIsrcs } from "./musicbrainz.ts";

/**
 * Finds MusicBrainz recordings for the matching of the core. The plugin owns HTTP, pacing and
 * response schemas; the core decides which match to accept.
 */
export const musicbrainzPlugin = new Plugin({
  id: "dyad.musicbrainz",
  setup: (context) =>
    Effect.gen(function* () {
      // One pacer for all lookups, because the limit is per IP
      const services = yield* Effect.context<HttpClient.HttpClient | Pacing>().pipe(
        Effect.provide(pacingLayer),
      );

      yield* context.musicbrainz.add(
        new MusicBrainzLookup({
          recordingsByIsrc: (isrcs) =>
            lookupIsrcs(isrcs).pipe(
              Effect.catchTags({
                RateLimited: (error) =>
                  Effect.fail(
                    new MusicBrainzError({
                      reason: "MusicBrainz is busy",
                      retryAfterSeconds: error.retryAfterSeconds ?? 0,
                    }),
                  ),
                LookupError: (error) =>
                  Effect.fail(
                    new MusicBrainzError({ reason: error.reason, retryAfterSeconds: null }),
                  ),
              }),
              Effect.provide(services),
            ),
        }),
      );
    }),
});
