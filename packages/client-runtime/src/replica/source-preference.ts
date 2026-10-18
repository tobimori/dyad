import { source, sourcePreference } from "@dyad/db/client";
import { SourcePreferenceRow, SourcePreferenceSet } from "@dyad/domain";
import type { HybridLogicalClock, SyncChange, UserId } from "@dyad/domain";
import { sourcePreferenceId } from "@dyad/sync";
import { Crypto, Data, Effect, Option } from "effect";

import { ClientDatabase, accountProvidersState } from "./database.ts";

/** The user's provider order, best first. Empty until the user sets one. */
export const localProviderOrder = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  // The replica has only the rows of its own user
  const [row] = yield* db.select().from(sourcePreference);
  return row?.providerRanking ?? [];
}).pipe(Effect.orDie);

export class ProviderChoice extends Data.Class<{
  /** `local` for files */
  readonly provider: string;
  readonly name: string;
}> {}

/**
 * The providers that the user can order: the order first, then local files, then the other
 * providers of the known sources by name. `custom` is false until the user sets an order.
 */
export const localProviderChoices = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  const order = yield* localProviderOrder;
  const names = Option.getOrNull(yield* accountProvidersState.get)?.names ?? {};
  const known = yield* db.selectDistinct({ provider: source.provider }).from(source);

  // Only providers with accounts have names on the replica
  const nameOf = (provider: string) => {
    if (provider === "local") return "Local files";
    return (
      names[provider] ?? provider.charAt(0).toUpperCase() + provider.slice(1).replaceAll("_", " ")
    );
  };
  const others = [...new Set(["local", ...known.map((row) => row.provider)])]
    .filter((provider) => !order.includes(provider))
    .toSorted(
      (a, b) => Number(b === "local") - Number(a === "local") || nameOf(a).localeCompare(nameOf(b)),
    );
  return {
    custom: order.length > 0,
    providers: [...order, ...others].map(
      (provider) => new ProviderChoice({ provider, name: nameOf(provider) }),
    ),
  };
}).pipe(Effect.orDie);

/** Replaces the user's provider order. It applies at once, also offline. */
export const setProviderOrder =
  <E>(
    mutate: <A>(
      build: (
        next: Effect.Effect<HybridLogicalClock>,
      ) => Effect.Effect<
        readonly [A, ReadonlyArray<SyncChange>],
        never,
        ClientDatabase | Crypto.Crypto
      >,
    ) => Effect.Effect<A>,
    owner: Effect.Effect<UserId, E>,
  ) =>
  (providerRanking: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const userId = yield* owner;
      return yield* mutate((next) =>
        Effect.gen(function* () {
          const row = new SourcePreferenceRow({
            table: "source_preference",
            id: yield* sourcePreferenceId(userId),
            userId,
            scope: "global",
            providerRanking,
            hlc: yield* next,
          });
          return [
            undefined,
            [new SourcePreferenceSet({ kind: "source_preference.set", schemaVersion: 1, row })],
          ];
        }),
      );
    });
