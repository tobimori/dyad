import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  AccountLinkFailed,
  AccountProviderSummary,
  ProviderAccountSummary,
  TokenLogin,
} from "@dyad/domain";
import { eq, sql } from "drizzle-orm";
import { HlcClock, uuidV5, wallTimeOf } from "@dyad/sync";
import { Effect, Schema } from "effect";

import { forgetDownloads } from "./downloads.ts";
import { nextChangeSeq } from "./sync-counter.ts";
import { forgetLibrary, queueLibrarySync } from "./library-sync.ts";
import { Providers, toCredentials } from "./providers.ts";
import { Recommenders, accountOf, forgetRecommendations, queueScrobbles } from "./recommenders.ts";

/** Providers with an account, then recommenders with their own */
export const listAccountProviders = Effect.gen(function* () {
  const providers = yield* Providers;
  const recommenders = yield* Recommenders;

  return [
    ...[...providers].map(([provider, { name, account, playlists }]) => ({
      provider,
      name,
      account,
      createsPlaylists: playlists?.create !== undefined,
    })),
    ...[...recommenders].flatMap(([provider, { name, account }]) =>
      providers.has(provider) ? [] : [{ provider, name, account, createsPlaylists: false }],
    ),
  ].flatMap(({ account, ...summary }) =>
    account === undefined ? [] : [new AccountProviderSummary({ ...summary, login: account.login })],
  );
});

export const listAccounts = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db.select().from(providerAccount).where(eq(providerAccount.deleted, false));

  return rows.map(
    (row) => new ProviderAccountSummary({ provider: row.provider, displayName: row.displayName }),
  );
});

export const linkAccount = Effect.fn("linkAccount")(function* (
  provider: string,
  values: Readonly<Record<string, string>>,
) {
  const db = yield* Database;
  const clock = yield* HlcClock;

  const account = yield* accountOf(provider);
  if (account === undefined) {
    return yield* new AccountLinkFailed({ reason: "Unknown provider" });
  }

  const login = account.login;
  const rule = Schema.is(TokenLogin)(login)
    ? { names: ["token"], required: ["token"], missing: `Enter the ${login.label}` }
    : {
        names: login.cookies,
        required: login.requiredCookies ?? login.cookies,
        missing: "The import did not give all required cookies",
      };
  const Required = Schema.Record(
    Schema.Literals(rule.required),
    Schema.String.check(Schema.isMinLength(1)),
  );
  yield* Schema.decodeEffect(Required)(values).pipe(
    Effect.mapError(() => new AccountLinkFailed({ reason: rule.missing })),
  );
  const stored = Object.fromEntries(
    Object.entries(values).filter(([name]) => rule.names.includes(name)),
  );
  const displayName = yield* account.link(toCredentials(stored));

  // The same ID on every replica, so that two links of one provider are one row
  // A row from before single user keeps its ID; the upsert finds it by provider
  const newId = yield* uuidV5(`provider_account:${provider}`);
  const hlc = yield* clock.next;
  yield* db.transaction(() =>
    Effect.gen(function* () {
      const changeSeq = yield* nextChangeSeq;
      const row = { displayName, createdAt: wallTimeOf(hlc), deleted: false, hlc, changeSeq };
      const [linked] = yield* db
        .insert(providerAccount)
        .values({ id: newId, provider, ...row })
        .onConflictDoUpdate({
          target: providerAccount.provider,
          set: row,
        })
        .returning({ id: providerAccount.id });
      if (linked === undefined) return yield* Effect.die("The account upsert returned no row");
      yield* db
        .insert(credential)
        .values({ providerAccountId: linked.id, values: stored })
        .onConflictDoUpdate({ target: credential.providerAccountId, set: { values: stored } });
    }),
  );
  yield* queueLibrarySync(provider);
  yield* queueScrobbles(provider);

  return new ProviderAccountSummary({ provider, displayName });
});

export const unlinkAccount = Effect.fn("unlinkAccount")(function* (provider: string) {
  const db = yield* Database;
  const clock = yield* HlcClock;
  const hlc = yield* clock.next;
  yield* db.transaction(() =>
    Effect.gen(function* () {
      const [account] = yield* db
        .update(providerAccount)
        .set({ deleted: true, hlc, changeSeq: yield* nextChangeSeq })
        .where(eq(providerAccount.provider, provider))
        .returning({ id: providerAccount.id });
      if (account !== undefined) {
        yield* db.delete(credential).where(eq(credential.providerAccountId, account.id));
      }
      yield* forgetLibrary(provider);
      yield* forgetDownloads(provider);
      yield* forgetRecommendations(provider);
    }),
  );

  // `secure_delete` overwrites the deleted credentials in the database file. The write-ahead log
  // still has copies of earlier pages until a checkpoint truncates it.
  yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
});
