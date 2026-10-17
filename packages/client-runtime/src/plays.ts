import type { PlayContext } from "@dyad/domain";
import { Clock, Data, Effect } from "effect";

import { ServerConnection } from "./connection.ts";
import type { QueueEntry } from "./queue.ts";

/** The play of the current entry, which the client reports with `recordPlay` when it ends */
export class CurrentPlay extends Data.Class<{
  readonly sourceId: string;
  readonly context: typeof PlayContext.Type;
  readonly startedAt: number;
  /** Played time before the last resume */
  readonly playedMs: number;
  /** `null` while paused */
  readonly resumedAt: number | null;
}> {}

export const startPlay = (entry: QueueEntry, now: number) =>
  new CurrentPlay({
    sourceId: entry.source.id,
    context: entry.context,
    startedAt: now,
    playedMs: 0,
    resumedAt: now,
  });

const playedUntil = (play: CurrentPlay, now: number) =>
  play.resumedAt === null ? play.playedMs : play.playedMs + now - play.resumedAt;

export const pausePlay = (play: CurrentPlay, now: number) =>
  new CurrentPlay({ ...play, playedMs: playedUntil(play, now), resumedAt: null });

export const resumePlay = (play: CurrentPlay, now: number) =>
  play.resumedAt === null ? new CurrentPlay({ ...play, resumedAt: now }) : play;

/** `completed` is `false` when the user skips the entry, plays another or quits */
export const reportPlay = (play: CurrentPlay, completed: boolean) =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const now = yield* Clock.currentTimeMillis;
    yield* connection.recordPlay({
      sourceId: play.sourceId,
      startedAt: play.startedAt,
      playedMs: playedUntil(play, now),
      completed,
      context: play.context,
    });
  });
