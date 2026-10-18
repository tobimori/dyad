import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  AccountLinkFailed,
  AccountProviderSummary,
  CurrentPrincipal,
  ProviderAccountSummary,
  TokenLogin,
} from "@dyad/domain";
import { and, eq, sql } from "drizzle-orm";
import { Clock, Crypto, Effect, Schema } from "effect";

import { forgetDownloads } from "./downloads.ts";
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
  const principal = yield* CurrentPrincipal;
  const rows = yield* db
    .select()
    .from(providerAccount)
    .where(eq(providerAccount.userId, principal.userId));

  return rows.map(
    (row) => new ProviderAccountSummary({ provider: row.provider, displayName: row.displayName }),
  );
});

export const linkAccount = (provider: string, values: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const principal = yield* CurrentPrincipal;

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

    const id = yield* crypto.randomUUIDv7().pipe(Effect.orDie);
    const createdAt = yield* Clock.currentTimeMillis;
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .delete(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, principal.userId),
              eq(providerAccount.provider, provider),
            ),
          );
        yield* tx
          .insert(providerAccount)
          .values({ id, userId: principal.userId, provider, displayName, createdAt });
        yield* tx.insert(credential).values({ providerAccountId: id, values: stored });
      }),
    );
    yield* queueLibrarySync(principal.userId, provider);
    yield* queueScrobbles(principal.userId, provider);

    return new ProviderAccountSummary({ provider, displayName });
  });

export const unlinkAccount = (provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* db
          .delete(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, principal.userId),
              eq(providerAccount.provider, provider),
            ),
          );
        yield* forgetLibrary(principal.userId, provider);
        yield* forgetDownloads(principal.userId, provider);
        yield* forgetRecommendations(principal.userId, provider);
      }),
    );

    // `secure_delete` overwrites the deleted credentials in the database file. The write-ahead log
    // still has copies of earlier pages until a checkpoint truncates it.
    yield* db.run(sql`PRAGMA wal_checkpoint(TRUNCATE)`);
  });
