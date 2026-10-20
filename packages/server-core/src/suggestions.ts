import { playEvent, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { SourceSummary } from "@dyad/domain";
import type { ProviderSource, Suggestion } from "@dyad/plugin";
import { count, eq, gte, inArray, sql } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";

import { cacheProviderSources, cachedProviderSource, cachedSummary } from "./provider-cache.ts";
import { callProvider, usableProviders } from "./providers.ts";
import { playHistoryMs } from "./ranking.ts";
import { RecommendationMemory } from "./recommenders.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { songKey } from "./taste.ts";

// A found source or a miss stays for a day, so each song costs at most one search a day
const foundLifetimeMs = 24 * 60 * 60 * 1000;
const searchTimeout = "8 seconds";

/**
 * A search of the usable provider that the user plays most, so that suggestions play where the
 * user listens; ties go to the curated catalog. It gives the first result with the song key.
 */
const searchOfUser = Effect.gen(function* () {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;
  const providers = yield* usableProviders;
  const counts = yield* db
    .select({ provider: source.provider, plays: count() })
    .from(playEvent)
    .innerJoin(source, eq(source.id, playEvent.sourceId))
    .where(gte(playEvent.startedAt, now - playHistoryMs))
    .groupBy(source.provider);
  const plays = new Map(counts.map((row) => [row.provider, row.plays]));

  const [chosen] = [...providers].toSorted(
    ([a, first], [b, second]) =>
      Number(second.provider.search !== undefined) - Number(first.provider.search !== undefined) ||
      (plays.get(b) ?? 0) - (plays.get(a) ?? 0) ||
      (second.provider.factRank?.metadata ?? 0) - (first.provider.factRank?.metadata ?? 0),
  );
  const search = chosen?.[1].provider.search;
  if (chosen === undefined || search === undefined) return undefined;
  const [id, usable] = chosen;

  // A failure or a timeout finds nothing
  return (query: string, key: string) =>
    Effect.gen(function* () {
      const results = Option.getOrElse(
        yield* callProvider(
          "Suggestion search",
          searchTimeout,
          search(query, usable.credentials).pipe(Effect.map((answer) => answer.songs)),
        ).pipe(Effect.annotateLogs("provider", id)),
        () => [],
      );
      const cached = yield* cacheProviderSources(id, results);
      const summaries = yield* Effect.forEach(cached, (item) =>
        cachedSummary(item, usable.provider.name),
      );
      return summaries.find((summary) => songKey(summary.title, summary.artist) === key);
    });
});

/**
 * A playable source for each suggestion, or `undefined`: the recommender's own source, else a
 * source on this replica with the same song key, else one that an earlier search found. Then at
 * most `searches` of the others search one provider, in order.
 */
export const resolveSuggestions = Effect.fn("resolveSuggestions")(function* (
  items: ReadonlyArray<{ readonly suggestion: Suggestion; readonly recommender: string }>,
  searches: number,
) {
  const memory = yield* RecommendationMemory;
  const providers = yield* usableProviders;
  const now = yield* Clock.currentTimeMillis;
  const found: Array<SourceSummary | undefined> = items.map(() => undefined);
  const nameOf = (provider: string) => providers.get(provider)?.provider.name ?? provider;

  const own = new Map<string, Array<readonly [number, ProviderSource]>>();
  items.forEach(({ suggestion, recommender }, index) => {
    if (suggestion.source === null || !providers.has(recommender)) return;
    own.set(recommender, [...(own.get(recommender) ?? []), [index, suggestion.source]]);
  });
  for (const [provider, entries] of own) {
    const cached = yield* cacheProviderSources(
      provider,
      entries.map(([, item]) => item),
    );
    for (const [position, item] of cached.entries()) {
      const index = entries[position]?.[0];
      if (index !== undefined) found[index] = yield* cachedSummary(item, nameOf(provider));
    }
  }

  const missing = items.flatMap(({ suggestion }, index) =>
    found[index] === undefined
      ? [{ index, suggestion, key: songKey(suggestion.title, suggestion.artist) }]
      : [],
  );
  const titles = [...new Set(missing.map(({ suggestion }) => suggestion.title.toLowerCase()))];
  const rows =
    titles.length === 0
      ? []
      : yield* playableSources(inArray(sql`lower(${source.rawTitle})`, titles));
  const local = new Map(
    rows.map((row) => {
      const summary = sourceSummary(row);
      return [songKey(summary.title, summary.artist), summary] as const;
    }),
  );

  const unknown: Array<(typeof missing)[number]> = [];
  for (const item of missing) {
    const earlier = memory.found.get(item.key);
    const fresh = earlier !== undefined && now - earlier.at < foundLifetimeMs;
    const cached =
      fresh && earlier.sourceId !== null
        ? yield* cachedProviderSource(earlier.sourceId)
        : Option.none();
    const playable = Option.filter(cached, (value) => providers.has(value.provider));
    found[item.index] =
      local.get(item.key) ??
      (Option.isSome(playable)
        ? yield* cachedSummary(playable.value, nameOf(playable.value.provider))
        : undefined);
    const searchedBefore = unknown.some((other) => other.key === item.key);
    if (found[item.index] === undefined && !fresh && !searchedBefore) unknown.push(item);
  }

  const search = unknown.length === 0 || searches === 0 ? undefined : yield* searchOfUser;
  if (search !== undefined) {
    for (const item of unknown.slice(0, searches)) {
      const summary = yield* search(`${item.suggestion.artist} ${item.suggestion.title}`, item.key);
      memory.found.set(item.key, { sourceId: summary?.id ?? null, at: now });
      found[item.index] = summary;
    }
  }

  for (const [key, entry] of memory.found) {
    if (now - entry.at >= foundLifetimeMs) memory.found.delete(key);
  }
  return found;
});
