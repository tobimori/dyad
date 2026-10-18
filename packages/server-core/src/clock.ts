import { catalogAssertion, entityMerge, libraryItem, playlist, playlistEntry } from "@dyad/db";
import { Database, ReplicaDatabase, orDieOnDatabaseError } from "@dyad/db/node";
import { HybridLogicalClock, ReplicaId } from "@dyad/domain";
import { hlcClockLayer, wallTimeOf } from "@dyad/sync";
import { max } from "drizzle-orm";
import { Clock, Effect, Layer, Schema } from "effect";

/** An HLC that is further ahead of the server clock is wrong */
export const maxClockAheadMs = 10 * 60 * 1000;

/** The clock of this replica. It continues after the highest stored HLC. */
export const hlcClockFromDatabase = Layer.unwrap(
  Effect.gen(function* () {
    const db = yield* Database;
    const identity = yield* ReplicaDatabase;

    const maxima = yield* Effect.all([
      db.select({ hlc: max(libraryItem.hlc) }).from(libraryItem),
      db.select({ hlc: max(playlist.hlc) }).from(playlist),
      db.select({ hlc: max(playlistEntry.hlc) }).from(playlistEntry),
      db.select({ hlc: max(catalogAssertion.hlc) }).from(catalogAssertion),
      db.select({ hlc: max(entityMerge.hlc) }).from(entityMerge),
    ]).pipe(orDieOnDatabaseError("loadClock"));
    const stored = maxima.flatMap(([row]) => row?.hlc ?? []).toSorted();
    const latest = yield* Schema.decodeEffect(Schema.NullOr(HybridLogicalClock))(
      stored.at(-1) ?? null,
    );

    const now = yield* Clock.currentTimeMillis;
    if (latest !== null && wallTimeOf(latest) > now + maxClockAheadMs) {
      yield* Effect.logWarning("The highest stored HLC is ahead of the wall clock").pipe(
        Effect.annotateLogs("hlc", latest),
      );
    }

    const replicaId = yield* Schema.decodeEffect(ReplicaId)(identity.replicaId);
    return hlcClockLayer({ replicaId, latest });
  }),
);
