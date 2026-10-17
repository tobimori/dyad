import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { eq } from "drizzle-orm";
import { EffectDrizzleQueryError } from "drizzle-orm/effect-core";
import * as Drizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { Clock, Context, Crypto, Effect, Layer, Path, Schema } from "effect";
import { SqlError } from "effect/sql";

import { relations } from "./relations.ts";
import { replicaIdentity } from "./schema/replica.ts";

export class Identity extends Schema.Class<Identity>("Identity")({
  replicaId: Schema.String.check(Schema.isUUID()),
  workspaceId: Schema.String.check(Schema.isUUID()),
}) {}

export class ReplicaDatabase extends Context.Service<ReplicaDatabase, Identity>()(
  "@dyad/db/ReplicaDatabase",
) {}

const makeDatabase = Effect.gen(function* () {
  const db = yield* Drizzle.makeWithDefaults({ relations });
  const path = yield* Path.Path;
  const migrationsFolder = yield* path.fromFileUrl(new URL("../migrations/", import.meta.url));
  yield* migrate(db, { migrationsFolder });
  return db;
});

export class Database extends Context.Service<Database, Effect.Success<typeof makeDatabase>>()(
  "@dyad/db/Database",
) {}

// RETURN TYPE: the guard keeps the other errors of `E`, so `catchIf` removes only database errors
const isDatabaseError = <E>(
  error: E,
): error is Extract<E, SqlError.SqlError | EffectDrizzleQueryError> =>
  SqlError.isSqlError(error) || Schema.is(EffectDrizzleQueryError)(error);

/** Makes database errors defects, so that a handler fails only with the errors of its contract */
export const orDieOnDatabaseError = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catchIf(effect, isDatabaseError, Effect.die);

export const nodeDatabaseLayer = (filename: string) =>
  Layer.effect(
    ReplicaDatabase,
    Effect.gen(function* () {
      const db = yield* Database;
      const crypto = yield* Crypto.Crypto;

      return yield* db.transaction((tx) =>
        Effect.gen(function* () {
          const rows = yield* tx.select().from(replicaIdentity).where(eq(replicaIdentity.slot, 1));
          const existing = rows[0];
          if (existing !== undefined) {
            return yield* Schema.decodeEffect(Identity)(existing);
          }

          const identity = {
            replicaId: yield* crypto.randomUUIDv4(),
            workspaceId: yield* crypto.randomUUIDv4(),
          };
          const createdAt = yield* Clock.currentTimeMillis;
          yield* tx.insert(replicaIdentity).values({ slot: 1, ...identity, createdAt });
          return yield* Schema.decodeEffect(Identity)(identity);
        }),
      );
    }),
  ).pipe(
    Layer.provideMerge(Layer.effect(Database, makeDatabase)),
    Layer.provide(SqliteClient.layer({ filename })),
  );
