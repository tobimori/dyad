import { playEvent, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { DeviceId, PlayContext } from "@dyad/domain";
import { desc, inArray, sql } from "drizzle-orm";
import { Crypto, Effect } from "effect";

import { playableSources, sourceSummary } from "./sources.ts";
import { nextChangeSeq } from "./sync-counter.ts";

const recentPlayLimit = 100;

export const insertPlay = Effect.fn("insertPlay")(function* (play: {
  readonly deviceId: DeviceId;
  readonly sourceId: string;
  readonly startedAt: number;
  readonly playedMs: number;
  readonly completed: boolean;
  readonly context: typeof PlayContext.Type;
}) {
  const db = yield* Database;
  const crypto = yield* Crypto.Crypto;
  const id = yield* crypto.randomUUIDv7().pipe(Effect.orDie);
  yield* db.transaction(() =>
    Effect.gen(function* () {
      const changeSeq = yield* nextChangeSeq;
      yield* db.insert(playEvent).values({ ...play, id, changeSeq });
    }),
  );
});

/** The playable sources of the user's last plays, newest play first, one entry per source */
export const listRecentPlays = Effect.gen(function* () {
  const db = yield* Database;

  const lastPlayedAt = sql<number>`max(${playEvent.startedAt})`;
  const plays = yield* db
    .select({ sourceId: playEvent.sourceId, lastPlayedAt })
    .from(playEvent)
    .groupBy(playEvent.sourceId)
    .orderBy(desc(lastPlayedAt))
    .limit(recentPlayLimit);

  const playedIds = plays.map((play) => play.sourceId);
  const rows = yield* playableSources(inArray(source.id, playedIds));
  const summaries = new Map(rows.map((row) => [row.source.id, sourceSummary(row)]));

  return plays.flatMap((play) => summaries.get(play.sourceId) ?? []);
});
