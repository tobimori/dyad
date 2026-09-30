import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { eq } from "drizzle-orm";
import * as Drizzle from "drizzle-orm/effect-sqlite-node";
import { migrate } from "drizzle-orm/effect-sqlite-node/migrator";
import { Clock, Context, Crypto, Effect, Layer, Path, Schema } from "effect";

import { replicaIdentity } from "./schema.ts";

const Identity = Schema.Struct({
  replicaId: Schema.String.check(Schema.isUUID()),
  workspaceId: Schema.String.check(Schema.isUUID()),
});
export type Identity = typeof Identity.Type;

export interface NodeDatabaseOptions {
  readonly filename: string;
}

export class ReplicaDatabase extends Context.Service<ReplicaDatabase, Identity>()(
  "@dyad/db/ReplicaDatabase",
) {}

export const nodeDatabaseLayer = (options: NodeDatabaseOptions) =>
  Layer.effect(
    ReplicaDatabase,
    Effect.gen(function* initializeReplicaDatabase() {
      const db = yield* Drizzle.makeWithDefaults();
      const crypto = yield* Crypto.Crypto;
      const path = yield* Path.Path;
      const migrationsFolder = yield* path.fromFileUrl(new URL("../migrations/", import.meta.url));
      yield* migrate(db, { migrationsFolder });

      return yield* db.transaction((tx) =>
        Effect.gen(function* initializeIdentity() {
          const rows = yield* tx.select().from(replicaIdentity).where(eq(replicaIdentity.slot, 1));
          const existing = rows[0];
          if (existing !== undefined) {
            return yield* Schema.decodeEffect(Identity)(existing);
          }

          const identity = {
            replicaId: yield* crypto.randomUUIDv4,
            workspaceId: yield* crypto.randomUUIDv4,
          };
          const createdAt = yield* Clock.currentTimeMillis;
          yield* tx.insert(replicaIdentity).values({ slot: 1, ...identity, createdAt });
          return yield* Schema.decodeEffect(Identity)(identity);
        }),
      );
    }),
  ).pipe(Layer.provide(SqliteClient.layer({ filename: options.filename })));
