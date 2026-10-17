import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  AccountLinkFailed,
  AccountProviderSummary,
  CurrentPrincipal,
  ProviderAccountSummary,
} from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import type { AccountProvider } from "@dyad/plugin";
import { and, eq } from "drizzle-orm";
import { Clock, Context, Crypto, Effect, Layer, Option, Redacted, Schema } from "effect";

/** Account providers that plugins add, by provider name */
export class AccountProviders extends Context.Service<
  AccountProviders,
  Map<string, AccountProvider>
>()("@dyad/server-core/AccountProviders") {}

export const accountProvidersLayer = Layer.sync(AccountProviders, () => new Map());

const StoredCredentials = Schema.Record(Schema.String, Schema.String);

export const listAccountProviders = Effect.gen(function* () {
  const providers = yield* AccountProviders;
  return [...providers].map(
    ([provider, accountProvider]) =>
      new AccountProviderSummary({
        provider,
        name: accountProvider.name,
        login: accountProvider.login,
      }),
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

/** Credentials of the user's account of `provider` */
export const loadCredentials = (userId: UserId, provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ values: credential.values })
      .from(credential)
      .innerJoin(providerAccount, eq(providerAccount.id, credential.providerAccountId))
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)))
      .limit(1)
      .pipe(Effect.orDie);
    if (row === undefined) return Option.none();

    const values = yield* Schema.decodeUnknownEffect(StoredCredentials)(row.values).pipe(
      Effect.orDie,
    );
    return Option.some(
      new Map(Object.entries(values).map(([name, value]) => [name, Redacted.make(value)])),
    );
  });

const deleteAccount = (userId: UserId, provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;

    // SQLite does not enforce foreign keys here, so the credential is deleted explicitly
    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const accounts = yield* tx
          .select({ id: providerAccount.id })
          .from(providerAccount)
          .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
        for (const account of accounts) {
          yield* tx.delete(credential).where(eq(credential.providerAccountId, account.id));
          yield* tx.delete(providerAccount).where(eq(providerAccount.id, account.id));
        }
      }),
    );
  });

export const linkAccount = (provider: string, values: Readonly<Record<string, string>>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const principal = yield* CurrentPrincipal;
    const providers = yield* AccountProviders;

    const accountProvider = providers.get(provider);
    if (accountProvider === undefined) {
      return yield* new AccountLinkFailed({ reason: "Unknown provider" });
    }

    const credentials = new Map(
      Object.entries(values).map(([name, value]) => [name, Redacted.make(value)]),
    );
    const displayName = yield* accountProvider.link(credentials);

    const id = yield* crypto.randomUUIDv7().pipe(Effect.orDie);
    const createdAt = yield* Clock.currentTimeMillis;
    yield* deleteAccount(principal.userId, provider).pipe(Effect.orDie);
    yield* db
      .transaction((tx) =>
        Effect.gen(function* () {
          yield* tx
            .insert(providerAccount)
            .values({ id, userId: principal.userId, provider, displayName, createdAt });
          yield* tx.insert(credential).values({ providerAccountId: id, values });
        }),
      )
      .pipe(Effect.orDie);

    return new ProviderAccountSummary({ provider, displayName });
  });

export const unlinkAccount = (provider: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    yield* deleteAccount(principal.userId, provider);
  });
