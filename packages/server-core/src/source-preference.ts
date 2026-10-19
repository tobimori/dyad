import { source, sourcePreference } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { ProviderChoice, ProviderChoices, SourcePreferenceRow } from "@dyad/domain";
import { HlcClock, sourcePreferenceId } from "@dyad/sync";
import {} from "drizzle-orm";
import { Effect } from "effect";

import { Providers } from "./providers.ts";
import { writeRow } from "./replication.ts";
import { nextChangeSeq } from "./sync-counter.ts";

/** The user's provider order, best first. Empty until the user sets one. */
export const providerOrder = Effect.gen(function* () {
  const db = yield* Database;
  const [row] = yield* db
    .select({ providerRanking: sourcePreference.providerRanking })
    .from(sourcePreference);
  return row?.providerRanking ?? [];
});

/** The order first, then local files, then the other providers of the known sources by name */
export const listProviderChoices = Effect.gen(function* () {
  const db = yield* Database;
  const providers = yield* Providers;
  const order = yield* providerOrder;
  const known = yield* db.selectDistinct({ provider: source.provider }).from(source);

  const nameOf = (provider: string) => {
    if (provider === "local") return "Local files";
    return (
      providers.get(provider)?.name ??
      provider.charAt(0).toUpperCase() + provider.slice(1).replaceAll("_", " ")
    );
  };
  const others = [...new Set(["local", ...known.map((row) => row.provider)])]
    .filter((provider) => !order.includes(provider))
    .toSorted(
      (a, b) => Number(b === "local") - Number(a === "local") || nameOf(a).localeCompare(nameOf(b)),
    );
  return new ProviderChoices({
    custom: order.length > 0,
    providers: [...order, ...others].map(
      (provider) => new ProviderChoice({ provider, name: nameOf(provider) }),
    ),
  });
});

export const setProviderOrder = Effect.fn("setProviderOrder")(function* (
  providerRanking: ReadonlyArray<string>,
) {
  const clock = yield* HlcClock;
  const row = new SourcePreferenceRow({
    table: "source_preference",
    id: yield* sourcePreferenceId,
    scope: "global",
    providerRanking,
    hlc: yield* clock.next,
  });
  yield* writeRow(row, yield* nextChangeSeq);
});
