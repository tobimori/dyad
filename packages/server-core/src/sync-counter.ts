import { recording, replicaIdentity } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { eq, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";

/**
 * The `change_seq` for the rows that a write changes. Take it once, in the transaction of the write:
 * SQLite holds the write lock until the commit, so the values have the order of the commits.
 */
export const nextChangeSeq = Effect.gen(function* () {
  const db = yield* Database;

  const [row] = yield* db
    .update(replicaIdentity)
    .set({ changeSeq: sql`${replicaIdentity.changeSeq} + 1` })
    .where(eq(replicaIdentity.slot, 1))
    .returning({ changeSeq: replicaIdentity.changeSeq });
  if (row === undefined) return yield* Effect.die("The replica identity is missing");

  return row.changeSeq;
});

/**
 * Sets a new `revision` on the current root of each recording, so that clients load its merge
 * group again. Call it after the change.
 */
export const touchGroups = Effect.fn("touchGroups")(function* (recordingIds: Iterable<string>) {
  const db = yield* Database;
  const ids = [...new Set(recordingIds)];
  if (ids.length === 0) return;

  yield* db.transaction(() =>
    Effect.gen(function* () {
      const rows = yield* db
        .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
        .from(recording)
        .where(inArray(recording.id, ids));
      const roots = [...new Set(rows.map((row) => row.mergedIntoId ?? row.id))];
      if (roots.length === 0) return;

      yield* db
        .update(recording)
        .set({ revision: yield* nextChangeSeq })
        .where(inArray(recording.id, roots));
    }),
  );
});
