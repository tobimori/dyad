import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  AccountLinkFailed,
  AccountProviderSummary,
  CurrentPrincipal,
  ProviderAccountSummary,
} from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import type { AccountProvider, Credentials } from "@dyad/plugin";
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

/** Credentials of the user's account of `provider`, empty when the provider needs no account */
export const loadCredentials = (userId: UserId, provider: string) =>
  Effect.gen(function* () {
    const providers = yield* AccountProviders;
    if (!providers.has(provider)) return Option.some<Credentials>(new Map());

    const db = yield* Database;
    const [row] = yield* db
      .select({ values: credential.values })
      .from(credential)
      .innerJoin(providerAccount, eq(providerAccount.id, credential.providerAccountId))
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)))
      .limit(1);
    if (row === undefined) return Option.none();

    const values = yield* Schema.decodeUnknownEffect(StoredCredentials)(row.values).pipe(
      Effect.orDie,
    );
    return Option.some(
      new Map(Object.entries(values).map(([name, value]) => [name, Redacted.make(value)])),
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

    // Only the cookies that the provider declares are stored, not other keys from the client
    const DeclaredCookies = Schema.Record(
      Schema.Literals(accountProvider.login.cookies),
      Schema.String,
    );
    const stored = yield* Schema.decodeEffect(DeclaredCookies)(values).pipe(
      Effect.mapError(
        () => new AccountLinkFailed({ reason: "The sign-in did not give all cookies" }),
      ),
    );
    const credentials = new Map(
      Object.entries(stored).map(([name, value]) => [name, Redacted.make(value)]),
    );
    const displayName = yield* accountProvider.link(credentials);

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

    return new ProviderAccountSummary({ provider, displayName });
  });

export const unlinkAccount = (provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    yield* db
      .delete(providerAccount)
      .where(
        and(eq(providerAccount.userId, principal.userId), eq(providerAccount.provider, provider)),
      );
  });
