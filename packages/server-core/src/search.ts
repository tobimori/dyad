import { playEvent, providerItem, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, SearchResults, SourceSummary } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { PopularityHit, ProviderSource } from "@dyad/plugin";
import type { Popularity, Search } from "@dyad/plugin";
import { and, eq, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { Clock, Data, Effect, Layer, Option, Schedule, Schema, Stream } from "effect";

import { loadCredentials } from "./accounts.ts";
import { Tags, selectPlayableSources, sourceSummary, uuidV5 } from "./library.ts";
import { SourcePopularities, SourceSearches } from "./providers.ts";
import { Candidate, Play, playHistoryMs, rank } from "./ranking.ts";

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
    const unique = [...new Map(rows.map((row) => [row.source.id, row] as const)).values()];

    return unique.map((row, position) => {
      const tags = Schema.decodeUnknownOption(Tags)(row.tags);
      // ID3 stores the ISRC in the `TSRC` frame
      const isrc = Option.flatMapNullishOr(tags, (values) => values.isrc ?? values.tsrc);

      return new Candidate({
        summary: sourceSummary(row.source, row.variant),
        isrc: Option.getOrNull(Option.map(isrc, normalizeIsrc)),
        position,
        local: row.tags !== null,
        lossless: row.variant.lossless,
      });
    });
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
    const rows = yield* cacheProviderSources(providerSources);

    return rows.map(
      (row, position) =>
        new Candidate({
          summary: new SourceSummary({
            id: row.sourceId,
            provider: row.provider,
            title: row.data.title,
            artist: row.data.artist,
            album: row.data.album,
            durationMs: row.data.durationMs,
            codec: row.data.codec,
          }),
          isrc: row.isrc,
          position,
          local: false,
          lossless: row.data.lossless,
        }),
    );
  });

const fetchPopularity = (name: string, popularity: Popularity, query: string) =>
  popularity(query).pipe(
    Effect.map((hits) =>
      hits.map(
        (hit) =>
          new PopularityHit({
            ...hit,
            isrc: hit.isrc === null ? null : normalizeIsrc(hit.isrc),
          }),
      ),
    ),
    Effect.catchTag("SearchError", (error) =>
      Effect.logWarning("Popularity source failed", error.reason).pipe(
        Effect.annotateLogs("popularity", name),
        Effect.as([]),
      ),
    ),
  );

// Plays of the candidates, of their ISRCs and of their artists. The ISRC of a played provider
// source is known only while it is in the provider cache.
const loadPlays = (userId: UserId, candidates: ReadonlyArray<Candidate>, now: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const sourceIds = candidates.map((candidate) => candidate.summary.id);
    const isrcs = candidates.flatMap((candidate) => candidate.isrc ?? []);
    const artists = candidates.flatMap(
      (candidate) => candidate.summary.artist?.toLowerCase() ?? [],
    );

    const rows = yield* db
      .select({
        sourceId: playEvent.sourceId,
        isrc: providerItem.isrc,
        artist: source.rawArtist,
        startedAt: playEvent.startedAt,
        playedMs: playEvent.playedMs,
        completed: playEvent.completed,
      })
      .from(playEvent)
      .innerJoin(source, eq(source.id, playEvent.sourceId))
      .leftJoin(providerItem, eq(providerItem.sourceId, playEvent.sourceId))
      .where(
        and(
          eq(playEvent.userId, userId),
          gte(playEvent.startedAt, now - playHistoryMs),
          or(
            inArray(playEvent.sourceId, sourceIds),
            inArray(providerItem.isrc, isrcs),
            inArray(sql`lower(${source.rawArtist})`, artists),
          ),
        ),
      );

    return rows.map((row) => new Play(row));
  });

class Answer extends Data.Class<{
  readonly candidates: ReadonlyArray<Candidate>;
  readonly hits: ReadonlyArray<PopularityHit>;
}> {}

const rankAnswers = (query: string, userId: UserId, answer: Answer) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    // A played provider source is also a local result. The provider copy has the ISRC and the
    // position, and a provider can return an item twice.
    const candidates = [
      ...new Map(answer.candidates.map((candidate) => [candidate.summary.id, candidate])).values(),
    ];
    const plays = yield* loadPlays(userId, candidates, now);

    const ranked = rank(query, candidates, answer.hits, plays, now);
    return new SearchResults({ sources: ranked.map((result) => result.summary) });
  });

/**
 * The ranked sources on this replica first, then the complete ranked list again each time that a
 * provider search or a popularity source answers
 */
export const search = (query: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const searches = yield* SourceSearches;
      const popularities = yield* SourcePopularities;

      const local = yield* searchLocalSources(query, principal.userId);

      const providerAnswers = [...searches].map(([provider, providerSearch]) =>
        searchProvider(provider, providerSearch, query, principal.userId).pipe(
          Effect.map((candidates) => new Answer({ candidates, hits: [] })),
        ),
      );
      const popularityAnswers = [...popularities].map(([name, popularity]) =>
        fetchPopularity(name, popularity, query).pipe(
          Effect.map((hits) => new Answer({ candidates: [], hits })),
        ),
      );

      return Stream.fromIterable([...providerAnswers, ...popularityAnswers]).pipe(
        Stream.flatMap(Stream.fromEffect, { concurrency: "unbounded" }),
        Stream.scan(
          () => new Answer({ candidates: local, hits: [] }),
          (all, next) =>
            new Answer({
              candidates: [...all.candidates, ...next.candidates],
              hits: [...all.hits, ...next.hits],
            }),
        ),
        Stream.mapEffect((all) => rankAnswers(query, principal.userId, all)),
      );
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
