import { playbackSession, providerItem, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { ProviderSource } from "@dyad/plugin";
import { and, eq, lt, notInArray, sql } from "drizzle-orm";
import { Clock, Data, Effect, Layer, Option, Schema } from "effect";

import { sourceId } from "./ids.ts";
import { Jobs } from "./jobs.ts";
import { normalizeIsrc } from "./normalize.ts";

// Results of played sources do not expire, because `source` has no artwork and no ISRC. The TTL
// only limits the size of the cache.
const cacheLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sweepIntervalMs = 6 * 60 * 60 * 1000;
const sweepJob = "provider-cache.sweep";

/** A search result in the provider cache of this replica */
export class CachedSource extends Data.Class<{
  /** The ID that the result gets in `source` when it is played */
  readonly sourceId: string;
  readonly provider: string;
  /** Normalized with `normalizeIsrc` */
  readonly isrc: string | null;
  readonly source: ProviderSource;
}> {}

/** Replaces the cached results of `provider` with the same external IDs */
export const cacheProviderSources = (provider: string, sources: ReadonlyArray<ProviderSource>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const fetchedAt = yield* Clock.currentTimeMillis;

    const cached = yield* Effect.forEach(sources, (source) =>
      Effect.gen(function* () {
        const id = yield* sourceId(provider, source.externalId);
        const isrc = source.isrc === null ? null : normalizeIsrc(source.isrc);
        return new CachedSource({ sourceId: id, provider, isrc, source });
      }),
    );
    const rows = yield* Effect.forEach(cached, (item) =>
      Effect.gen(function* () {
        const data = yield* Schema.encodeEffect(ProviderSource)(item.source).pipe(Effect.orDie);
        return {
          sourceId: item.sourceId,
          provider,
          externalId: item.source.externalId,
          isrc: item.isrc,
          data,
          fetchedAt,
        };
      }),
    );

    yield* db.transaction((tx) =>
      Effect.forEach(
        rows,
        (row) =>
          tx
            .insert(providerItem)
            .values(row)
            .onConflictDoUpdate({ target: providerItem.sourceId, set: row }),
        { discard: true },
      ),
    );

    return cached;
  });

/** The cached search result with this source ID */
export const cachedProviderSource = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ provider: providerItem.provider, isrc: providerItem.isrc, data: providerItem.data })
      .from(providerItem)
      .where(eq(providerItem.sourceId, id))
      .limit(1);
    if (row === undefined) return Option.none();

    const source = yield* Schema.decodeUnknownEffect(ProviderSource)(row.data).pipe(Effect.orDie);
    return Option.some(
      new CachedSource({ sourceId: id, provider: row.provider, isrc: row.isrc, source }),
    );
  });

/** Deletes expired search results when the server starts and then every 6 hours */
export const providerCacheSweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;

    yield* jobs.register(sweepJob, Schema.Struct({}), () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* db.delete(providerItem).where(
          and(
            lt(providerItem.fetchedAt, now - cacheLifetimeMs),
            notInArray(providerItem.sourceId, db.select({ id: source.id }).from(source)),
            // A queued search result plays from this cache, maybe weeks later
            sql`${providerItem.sourceId} NOT IN (SELECT json_extract(entry.value, '$.source.id') FROM ${playbackSession}, json_each(${playbackSession.entries}) AS entry)`,
          ),
        );
        yield* jobs.enqueue(sweepJob, sweepJob, {}, { runAt: now + sweepIntervalMs });
      }),
    );

    // Enqueue keeps the earlier run time, so this also moves a waiting run from before the restart to now
    yield* jobs.enqueue(sweepJob, sweepJob, {});
  }).pipe(Effect.orDie),
);
