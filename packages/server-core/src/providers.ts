import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { UserId } from "@dyad/domain";
import type { Credentials, PopularityHit, Provider, ProviderError } from "@dyad/plugin";
import { and, eq } from "drizzle-orm";
import { Context, Data, Effect, Layer, Redacted } from "effect";

/** Providers that plugins add, by provider ID */
export class Providers extends Context.Service<Providers, Map<string, Provider>>()(
  "@dyad/server-core/Providers",
) {}

export const providersLayer = Layer.sync(Providers, () => new Map());

/** Popularity sources for search ranking that plugins add, by name */
export class Popularities extends Context.Service<
  Popularities,
  Map<string, (query: string) => Effect.Effect<ReadonlyArray<PopularityHit>, ProviderError>>
>()("@dyad/server-core/Popularities") {}

export const popularitiesLayer = Layer.sync(Popularities, () => new Map());

/** Credentials as the plugins get them, from the values that `linkAccount` stores */
export const toCredentials = (values: Readonly<Record<string, string>>) =>
  new Map(Object.entries(values).map(([name, value]) => [name, Redacted.make(value)]));

/**
 * The providers whose copies the user sees: they need no account, or an account of them is linked
 * on some replica. Playing a copy can still need the replica with the credential.
 */
export const linkedProviders = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;
    const accounts = yield* db
      .select({ provider: providerAccount.provider })
      .from(providerAccount)
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.deleted, false)));
    const linked = new Set(accounts.map((account) => account.provider));
    return new Map(
      [...providers].filter(
        ([id, provider]) =>
          provider.account === undefined || linked.has(id) || provider.account.optional === true,
      ),
    );
  });

/** A provider that one user can search and play, with the user's credentials */
class UsableProvider extends Data.Class<{
  readonly provider: Provider;
  /** Empty when the provider needs no account */
  readonly credentials: Credentials;
}> {}

/**
 * The providers that need no account or have an optional one, and the providers of which the user
 * linked an account
 */
export const usableProviders = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;

    const accounts = yield* db
      .select({ provider: providerAccount.provider, values: credential.values })
      .from(providerAccount)
      .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id))
      .where(eq(providerAccount.userId, userId));
    const linked = new Map(accounts.map((account) => [account.provider, account.values]));

    const usable = new Map<string, UsableProvider>();
    for (const [id, provider] of providers) {
      const values = linked.get(id);
      if (
        provider.account === undefined ||
        (values === undefined && provider.account.optional === true)
      ) {
        usable.set(id, new UsableProvider({ provider, credentials: new Map() }));
        continue;
      }
      if (values === undefined) continue;

      usable.set(id, new UsableProvider({ provider, credentials: toCredentials(values) }));
    }

    return usable;
  });
