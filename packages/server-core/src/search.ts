import { providerItem, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, SourceSummary } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { ProviderSource } from "@dyad/plugin";
import type { Search } from "@dyad/plugin";
import { eq, lt, or, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { Clock, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";

import { loadCredentials } from "./accounts.ts";
import { Tags, selectPlayableSources, sourceSummary, uuidV5 } from "./library.ts";
import { SourceSearches } from "./providers.ts";

const localResultLimit = 50;

// Played results are in `source` and do not expire. The TTL only limits the size of the cache.
const cacheLifetimeMs = 7 * 24 * 60 * 60 * 1000;

class CachedProviderSource extends Schema.Class<CachedProviderSource>("CachedProviderSource")({
  provider: Schema.String,
  externalId: Schema.String,
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
  isrc: Schema.NullOr(Schema.String),
  container: Schema.String,
  codec: Schema.String,
  lossless: Schema.Boolean,
  encrypted: Schema.Boolean,
}) {}

// Tags and providers can write an ISRC with hyphens, for example `US-RC1-76-07839`
const normalizeIsrc = (isrc: string) => isrc.replaceAll("-", "").trim().toUpperCase();

const searchLocalSources = (query: string, userId: UserId) =>
  Effect.gen(function* () {
    // `%` and `_` in the query match only themselves
    const pattern = `%${query.replaceAll(/[\\%_]/g, "\\$&")}%`;
    const contains = (column: Column) => sql`${column} like ${pattern} escape '\\'`;
    const match = or(
      contains(source.rawTitle),
      contains(source.rawArtist),
      contains(source.rawAlbum),
    );
    const playable = yield* selectPlayableSources(userId, match);
    const rows = yield* playable.limit(localResultLimit);

    // A source with several files has one row per file
    const summaries = new Map(
      rows.map((row) => [row.source.id, sourceSummary(row.source, row.variant)] as const),
    );

    const isrcs = rows.flatMap((row) => {
      const tags = Schema.decodeUnknownOption(Tags)(row.tags);
      // ID3 stores the ISRC in the `TSRC` frame
      const isrc = Option.flatMapNullishOr(tags, (values) => values.isrc ?? values.tsrc);
      return Option.toArray(isrc).map(normalizeIsrc);
    });

    return { summaries: [...summaries.values()], isrcs: new Set(isrcs) };
  });

const cacheProviderSources = (providerSources: ReadonlyArray<ProviderSource>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const fetchedAt = yield* Clock.currentTimeMillis;

    const rows = yield* Effect.forEach(providerSources, (providerSource) =>
      Effect.gen(function* () {
        const sourceId = yield* uuidV5(`${providerSource.provider}:${providerSource.externalId}`);
        const isrc = providerSource.isrc === null ? null : normalizeIsrc(providerSource.isrc);
        return {
          sourceId,
          provider: providerSource.provider,
          externalId: providerSource.externalId,
          isrc,
          data: providerSource,
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

    return rows;
  });

const searchProvider = (provider: string, providerSearch: Search, query: string, userId: UserId) =>
  Effect.gen(function* () {
    const credentials = yield* loadCredentials(userId, provider);
    if (Option.isNone(credentials)) return [];

    const providerSources = yield* providerSearch(query, credentials.value).pipe(
      Effect.catchTag("SearchError", (error) =>
        Effect.logWarning("Provider search failed", error.reason).pipe(
          Effect.annotateLogs("provider", provider),
          Effect.as([]),
        ),
      ),
    );
    return yield* cacheProviderSources(providerSources);
  });

/** Sources on this replica first, then the results of each provider that the user can use */
export const search = (query: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const searches = yield* SourceSearches;

      const local = yield* searchLocalSources(query, principal.userId);
      const emittedIds = new Set(local.summaries.map((summary) => summary.id));

      const providerResults = Stream.fromIterable([...searches]).pipe(
        Stream.flatMap(
          ([provider, providerSearch]) =>
            Stream.fromIterableEffect(
              searchProvider(provider, providerSearch, query, principal.userId),
            ),
          { concurrency: "unbounded" },
        ),
        // A local file of the same recording plays first, so its provider result is not shown
        Stream.filter((row) => row.isrc === null || !local.isrcs.has(row.isrc)),
        // A played result can also be a local result, and a provider can return an item twice
        Stream.filter((row) => {
          if (emittedIds.has(row.sourceId)) return false;
          emittedIds.add(row.sourceId);
          return true;
        }),
        Stream.map(
          (row) =>
            new SourceSummary({
              id: row.sourceId,
              provider: row.provider,
              title: row.data.title,
              artist: row.data.artist,
              album: row.data.album,
              durationMs: row.data.durationMs,
              codec: row.data.codec,
            }),
        ),
      );

      return Stream.fromIterable(local.summaries).pipe(Stream.concat(providerResults));
    }),
  );

/** The cached search result with this source ID */
export const cachedProviderSource = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ data: providerItem.data })
      .from(providerItem)
      .where(eq(providerItem.sourceId, sourceId))
      .limit(1);
    if (row === undefined) return Option.none();

    const data = yield* Schema.decodeUnknownEffect(CachedProviderSource)(row.data).pipe(
      Effect.orDie,
    );
    return Option.some(new ProviderSource(data));
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
