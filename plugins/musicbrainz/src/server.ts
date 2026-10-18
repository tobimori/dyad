import { MusicBrainzError, MusicBrainzLookup, Plugin } from "@dyad/plugin";
import type { MusicBrainzRecording } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { Pacing, RateLimited, pacingLayer } from "./http.ts";
import type { LookupError } from "./http.ts";
import { lookupRecordings } from "./listenbrainz.ts";
import { lookupIsrcs, searchRecording } from "./musicbrainz.ts";
import { listenbrainzRecommender } from "./recommender.ts";

const toMusicBrainzError = (error: LookupError | RateLimited) =>
  error instanceof RateLimited
    ? new MusicBrainzError({
        reason: "MusicBrainz is busy",
        retryAfterSeconds: error.retryAfterSeconds ?? 0,
      })
    : new MusicBrainzError({ reason: error.reason, retryAfterSeconds: null });

// The ListenBrainz mapper first. Only its misses use the MusicBrainz search, which allows one
// request per second.
const recordingsByText = (
  items: ReadonlyArray<{ readonly key: string; readonly artist: string; readonly title: string }>,
) =>
  Effect.gen(function* () {
    const mapped = yield* lookupRecordings(items);
    const searched = yield* Effect.forEach(
      items.filter((item) => !mapped.has(item.key)),
      (item) =>
        searchRecording(item.artist, item.title).pipe(
          Effect.map((recordings) => [item.key, recordings] as const),
        ),
    );
    return new Map<string, ReadonlyArray<MusicBrainzRecording>>([
      ...[...mapped].map(([key, recording]) => [key, [recording]] as const),
      ...searched,
    ]);
  });

/**
 * Finds MusicBrainz recordings for the matching of the core. The plugin owns HTTP, pacing and
 * response schemas; the core decides which match to accept. A ListenBrainz account adds scrobbles
 * and recommendations.
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
            lookupIsrcs(isrcs).pipe(Effect.mapError(toMusicBrainzError), Effect.provide(services)),
          recordingsByText: (items) =>
            recordingsByText(items).pipe(
              Effect.mapError(toMusicBrainzError),
              Effect.provide(services),
            ),
        }),
      );
      yield* context.recommenders.add("listenbrainz", yield* listenbrainzRecommender);
    }),
});
