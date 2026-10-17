import { playEvent, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal } from "@dyad/domain";
import type { PlayContext } from "@dyad/domain";
import { desc, eq, inArray, sql } from "drizzle-orm";
import { Crypto, Effect } from "effect";

import { selectPlayableSources, sourceSummary } from "./library.ts";

const recentPlayLimit = 100;

export const recordPlay = (play: {
  readonly sourceId: string;
  readonly startedAt: number;
  readonly playedMs: number;
  readonly completed: boolean;
  readonly context: typeof PlayContext.Type;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const principal = yield* CurrentPrincipal;
    const id = yield* crypto.randomUUIDv7().pipe(Effect.orDie);

    yield* db.insert(playEvent).values({
      id,
      userId: principal.userId,
      deviceId: principal.deviceId,
      ...play,
    });
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
  const query = yield* selectPlayableSources(principal.userId, inArray(source.id, playedIds));
  const rows = yield* query;
  const summaries = new Map(rows.map((row) => [row.source.id, sourceSummary(row)]));

  return plays.flatMap((play) => summaries.get(play.sourceId) ?? []);
});
