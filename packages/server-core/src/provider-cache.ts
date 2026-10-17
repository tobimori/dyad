import { providerItem } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { ProviderSource } from "@dyad/plugin";
import { eq, lt } from "drizzle-orm";
import { Clock, Data, Effect, Layer, Option, Schedule, Schema } from "effect";

import { sourceId } from "./ids.ts";
import { normalizeIsrc } from "./normalize.ts";

// Played results are in `source` and do not expire. The TTL only limits the size of the cache.
const cacheLifetimeMs = 7 * 24 * 60 * 60 * 1000;

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

    const sweep = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* db.delete(providerItem).where(lt(providerItem.fetchedAt, now - cacheLifetimeMs));
    }).pipe(Effect.catch((error) => Effect.logError("Cannot sweep the provider cache", error)));

    yield* Effect.forkScoped(sweep.pipe(Effect.repeat(Schedule.spaced("6 hours"))));
  }),
);
