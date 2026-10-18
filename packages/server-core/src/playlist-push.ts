import { Clock, Effect, Schema } from "effect";

import { Jobs } from "./jobs.ts";

export const playlistPushKind = "playlist.push";

export const PlaylistPushPayload = Schema.Struct({ playlistId: Schema.String });

// The wait collects the edits of a few seconds into one write
const pushDelayMs = 3000;

/** Sends the edits of a playlist with a two-way link to its provider, in the library job queue */
export const queuePlaylistPush = (playlistId: string) =>
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const now = yield* Clock.currentTimeMillis;
    yield* jobs.enqueue(playlistPushKind, playlistId, { playlistId }, { runAt: now + pushDelayMs });
  });
