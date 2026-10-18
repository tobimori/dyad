import { playEvent, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal } from "@dyad/domain";
import type { DeviceId, OfflinePlay, PlayContext, UserId } from "@dyad/domain";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { Crypto, Effect } from "effect";

import { playableSources, sourceSummary } from "./sources.ts";

const recentPlayLimit = 100;

export const insertPlay = (play: {
  /** A device gives its own ID to a play of offline time, so that a second upload adds nothing */
  readonly id?: string;
  readonly userId: UserId;
  readonly deviceId: DeviceId;
  readonly sourceId: string;
  readonly startedAt: number;
  readonly playedMs: number;
  readonly completed: boolean;
  readonly context: typeof PlayContext.Type;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const id = play.id ?? (yield* crypto.randomUUIDv7().pipe(Effect.orDie));
    yield* db
      .insert(playEvent)
      .values({ ...play, id })
      .onConflictDoNothing();
  });

/** The plays that the current device recorded while it was offline */
export const recordPlays = (plays: ReadonlyArray<OfflinePlay>) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    yield* Effect.forEach(
      plays,
      (play) => insertPlay({ ...play, userId: principal.userId, deviceId: principal.deviceId }),
      { discard: true },
    );
  });

/** The playable sources of the user's last plays, newest play first, one entry per source */
export const listRecentPlays = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;

  const lastPlayedAt = sql<number>`max(${playEvent.startedAt})`;
  const plays = yield* db
    .select({ sourceId: playEvent.sourceId, lastPlayedAt })
    .from(playEvent)
    .where(eq(playEvent.userId, principal.userId))
    .groupBy(playEvent.sourceId)
    .orderBy(desc(lastPlayedAt))
    .limit(recentPlayLimit);

  const playedIds = plays.map((play) => play.sourceId);
  const rows = yield* playableSources(principal.userId, inArray(source.id, playedIds));
  const summaries = new Map(rows.map((row) => [row.source.id, sourceSummary(row)]));

  return plays.flatMap((play) => summaries.get(play.sourceId) ?? []);
});
