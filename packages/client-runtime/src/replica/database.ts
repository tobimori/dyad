import { clientState, migrateClientDatabase } from "@dyad/db/client";
import { RecordingId } from "@dyad/domain";
import { eq } from "drizzle-orm";
import { EffectCache } from "drizzle-orm/cache/core/cache-effect";
import { EffectLogger } from "drizzle-orm/effect-core";
import { DefaultServices } from "drizzle-orm/effect-core/defaults";
import { effectSQLiteNodeCodecs } from "drizzle-orm/effect-sqlite-node/codecs";
import { EffectSQLiteNodeSession } from "drizzle-orm/effect-sqlite-node/session";
import { SQLiteDialect } from "drizzle-orm/sqlite-core";
import { SQLiteEffectDatabase } from "drizzle-orm/sqlite-core/effect";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { SqlClient } from "effect/sql";

// The driver modules of Drizzle import a platform client such as `node:sqlite`. The session and the
// codecs do not, so each platform can give its own `SqlClient`.
const makeDatabase = Effect.gen(function* () {
  const client = yield* SqlClient.SqlClient;
  const dialect = new SQLiteDialect({ codecs: effectSQLiteNodeCodecs });
  const session = new EffectSQLiteNodeSession(
    // SAFETY: the session calls only `unsafe` and `withTransaction`, which each `SqlClient` has
    client as ConstructorParameters<typeof EffectSQLiteNodeSession>[0],
    dialect,
    {},
    { logger: yield* EffectLogger, cache: yield* EffectCache },
  );
  const db = new SQLiteEffectDatabase(dialect, session, {});
  yield* migrateClientDatabase(db);
  return db;
}).pipe(Effect.provide(DefaultServices));

/** The client replica database */
export class ClientDatabase extends Context.Service<
  ClientDatabase,
  Effect.Success<typeof makeDatabase>
>()("@dyad/client-runtime/ClientDatabase") {}

/** Migrates the database of the `SqlClient`. A failed migration is a defect. */
export const clientDatabaseLayer = Layer.effect(ClientDatabase, Effect.orDie(makeDatabase));

/** One value in `client_state` */
export const stateKey = <T, E>(key: string, schema: Schema.Codec<T, E>) => ({
  get: Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const [row] = yield* db.select().from(clientState).where(eq(clientState.key, key));
    if (row === undefined) return Option.none<T>();
    return Option.some(yield* Schema.decodeUnknownEffect(schema)(row.value));
  }).pipe(Effect.orDie),
  set: (value: T) =>
    Effect.gen(function* () {
      const db = yield* ClientDatabase;
      const encoded = yield* Schema.encodeEffect(schema)(value);
      yield* db
        .insert(clientState)
        .values({ key, value: encoded })
        .onConflictDoUpdate({ target: clientState.key, set: { value: encoded } });
    }).pipe(Effect.orDie),
});

// Recordings that the server does not have. Each stays its own root without sources.
export const missingRecordingsState = stateKey("missingRecordings", Schema.Array(RecordingId));

/** The last answers of `listAccountProviders` and `listAccounts` */
export class AccountProviders extends Schema.Class<AccountProviders>("AccountProviders")({
  /** Display names of the providers that need an account */
  names: Schema.Record(Schema.String, Schema.String),
  /** The providers of the user's linked accounts */
  linked: Schema.Array(Schema.String),
}) {}

export const accountProvidersState = stateKey("accountProviders", AccountProviders);
