import { replicaIdentity } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { eq, sql } from "drizzle-orm";
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
