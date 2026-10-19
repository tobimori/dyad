import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { Credentials, PopularityHit, Provider, ProviderError } from "@dyad/plugin";
import { eq } from "drizzle-orm";
import { Clock, Context, Data, Duration, Effect, Layer, Option, Redacted } from "effect";

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

/** When each provider was last searched for each subject, by `<subject>:<provider>` */
export class ProviderSearches extends Context.Service<ProviderSearches, Map<string, number>>()(
  "@dyad/server-core/ProviderSearches",
) {}

export const providerSearchesLayer = Layer.sync(ProviderSearches, () => new Map());

// A subject, for example the copies of a song, costs at most one search of each provider a day
const searchLifetimeMs = 24 * 60 * 60 * 1000;

/** Whether `provider` was searched for `subject` in the last day */
export const searchedToday = Effect.fn(function* (subject: string, provider: string) {
  const at = (yield* ProviderSearches).get(`${subject}:${provider}`);
  return at !== undefined && (yield* Clock.currentTimeMillis) - at < searchLifetimeMs;
});

export const recordSearch = Effect.fn(function* (subject: string, provider: string) {
  (yield* ProviderSearches).set(`${subject}:${provider}`, yield* Clock.currentTimeMillis);
});

/** Credentials as the plugins get them, from the values that `linkAccount` stores */
export const toCredentials = (values: Readonly<Record<string, string>>) =>
  new Map(Object.entries(values).map(([name, value]) => [name, Redacted.make(value)]));

/**
 * The providers whose copies the user sees: they need no account, or an account of them is linked
 * on some replica. Playing a copy can still need the replica with the credential.
 */
export const linkedProviders = Effect.gen(function* () {
  const db = yield* Database;
  const providers = yield* Providers;
  const accounts = yield* db
    .select({ provider: providerAccount.provider })
    .from(providerAccount)
    .where(eq(providerAccount.deleted, false));
  const linked = new Set(accounts.map((account) => account.provider));
  return new Map(
    [...providers].filter(
      ([id, provider]) =>
        provider.account === undefined || linked.has(id) || provider.account.optional === true,
    ),
  );
});

/** A provider that this replica can search and play, with its credentials */
class UsableProvider extends Data.Class<{
  readonly provider: Provider;
  /** Empty when the provider needs no account */
  readonly credentials: Credentials;
}> {}

/**
 * The providers that need no account or have an optional one, and the providers of which the user
 * linked an account
 */
export const usableProviders = Effect.gen(function* () {
  const db = yield* Database;
  const providers = yield* Providers;

  const accounts = yield* db
    .select({ provider: providerAccount.provider, values: credential.values })
    .from(providerAccount)
    .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id));
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

/**
 * A plugin call that fails, times out or crashes gives `None` and a log line, so that one provider
 * does not stop the others. `what` names the call in the log, for example `Copy search`.
 */
export const callProvider = <A, R>(
  what: string,
  timeout: Duration.Input,
  call: Effect.Effect<A, ProviderError, R>,
) =>
  call.pipe(
    Effect.timeout(timeout),
    Effect.asSome,
    Effect.catchTags({
      ProviderError: (error) =>
        Effect.logWarning(`${what} failed`, error.reason).pipe(Effect.as(Option.none<A>())),
      TimeoutError: () => Effect.logWarning(`${what} timed out`).pipe(Effect.as(Option.none<A>())),
    }),
    Effect.catchDefect((defect) =>
      Effect.logError(`${what} crashed`, defect).pipe(Effect.as(Option.none<A>())),
    ),
  );
