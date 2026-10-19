import { catalogAssertion, playEvent, providerItem, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { SearchResults } from "@dyad/domain";
import { PopularityHit, ProviderSource } from "@dyad/plugin";
import type { Credentials, Provider, ProviderError } from "@dyad/plugin";
import { and, desc, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Column, SQL } from "drizzle-orm";
import { Array as Arr, Clock, Data, Effect, Option, Ref, Schema, Stream } from "effect";

import { normalizeIsrc } from "./normalize.ts";
import { cacheProviderSources, cachedSummary, toCachedSource } from "./provider-cache.ts";
import { Popularities, Providers, callProvider, usableProviders } from "./providers.ts";
import { Candidate, Play, playHistoryMs, rank } from "./ranking.ts";
import { withSeries } from "./sets.ts";
import { queueCopyDiscovery } from "./source-copies.ts";
import { providerOrder } from "./source-preference.ts";
import { playableSources, sourceSummary, tagIdentifiers } from "./sources.ts";

const localResultLimit = 50;
const discoveredResults = 5;

// One limit for the full answer of a provider search or a popularity source, with the token
// refreshes and retries of the plugin
const answerTimeout = "8 seconds";

const searchLocalSources = Effect.fn(function* (query: string) {
  const db = yield* Database;
  // `%` and `_` in the query match only themselves
  const pattern = `%${query.replaceAll(/[\\%_]/g, "\\$&")}%`;
  const contains = (column: Column | SQL) => sql`${column} like ${pattern} escape '\\'`;
  // A series name also finds the episodes whose titles leave it out
  const episodes = db
    .select({ id: catalogAssertion.entityId })
    .from(catalogAssertion)
    .where(
      and(
        eq(catalogAssertion.field, "series"),
        eq(catalogAssertion.retracted, false),
        contains(sql`json_extract(${catalogAssertion.value}, '$.name')`),
      ),
    );
  const match = or(
    contains(source.rawTitle),
    contains(source.rawArtist),
    contains(source.rawAlbum),
    inArray(source.recordingId, episodes),
  );
  const rows = yield* playableSources(match, localResultLimit);

  const candidates = rows.map((row, position) => {
    const isrc = row.tags === null ? null : tagIdentifiers(row.tags).isrc;

    return new Candidate({
      summary: sourceSummary(row),
      isrc: isrc === null ? null : normalizeIsrc(isrc),
      position,
      local: row.tags !== null,
      lossless: row.variant.lossless,
      upload: false,
    });
  });
  const summaries = yield* withSeries(candidates.map((candidate) => candidate.summary));
  const catalog = Arr.zipWith(
    candidates,
    summaries,
    (candidate, summary) => new Candidate({ ...candidate, summary }),
  );

  // Cached provider results, so that search finds the songs of opened pages, also offline
  const field = (path: string) => sql`json_extract(${providerItem.data}, ${path})`;
  const known = new Set(rows.map((row) => row.source.id));
  const cachedRows = yield* db
    .select({
      sourceId: providerItem.sourceId,
      provider: providerItem.provider,
      data: providerItem.data,
    })
    .from(providerItem)
    .where(or(contains(field("$.title")), contains(field("$.artist")), contains(field("$.album"))))
    .orderBy(desc(providerItem.fetchedAt))
    .limit(localResultLimit);
  const providers = yield* Providers;
  const cached = yield* Effect.forEach(
    cachedRows.filter((row) => !known.has(row.sourceId)),
    (row) =>
      Option.match(Schema.decodeUnknownOption(ProviderSource)(row.data), {
        onNone: () => Effect.succeed([]),
        onSome: (decoded) =>
          toCachedSource(row.provider, decoded).pipe(Effect.map((item) => [item])),
      }),
  );
  return [
    ...catalog,
    ...(yield* Effect.forEach(cached.flat(), (item, index) =>
      Effect.gen(function* () {
        const provider = providers.get(item.provider);
        return new Candidate({
          summary: yield* cachedSummary(item, provider?.name ?? item.provider),
          isrc: item.isrc,
          position: catalog.length + index,
          local: false,
          lossless: item.source.lossless,
          upload: provider?.uploads === true,
        });
      }),
    )),
  ];
});

class Answer extends Data.Class<{
  readonly candidates: ReadonlyArray<Candidate>;
  readonly hits: ReadonlyArray<PopularityHit>;
  readonly unavailable: ReadonlyArray<string>;
}> {}

// A failure, a defect or a timeout of one plugin skips only that provider
const searchProvider = Effect.fn(function* (
  id: string,
  name: string,
  search: NonNullable<Provider["search"]>,
  upload: boolean,
  credentials: Credentials,
  query: string,
) {
  const sources = yield* callProvider(
    "Provider search",
    answerTimeout,
    search(query, credentials),
  ).pipe(Effect.annotateLogs("provider", id));
  if (Option.isNone(sources)) {
    return new Answer({ candidates: [], hits: [], unavailable: [name] });
  }

  const cached = yield* cacheProviderSources(id, sources.value);
  const candidates = yield* Effect.forEach(cached, (item, position) =>
    Effect.gen(function* () {
      return new Candidate({
        summary: yield* cachedSummary(item, name),
        isrc: item.isrc,
        position,
        local: false,
        lossless: item.source.lossless,
        upload,
      });
    }),
  );
  return new Answer({ candidates, hits: [], unavailable: [] });
});

const fetchPopularity = (
  name: string,
  popularity: (query: string) => Effect.Effect<ReadonlyArray<PopularityHit>, ProviderError>,
  query: string,
) =>
  callProvider("Popularity source", answerTimeout, popularity(query)).pipe(
    Effect.map((hits) =>
      Option.getOrElse(hits, () => []).map(
        (hit) =>
          new PopularityHit({
            ...hit,
            isrc: hit.isrc === null ? null : normalizeIsrc(hit.isrc),
          }),
      ),
    ),
    Effect.annotateLogs("popularity", name),
  );

// Plays of the candidates, of their ISRCs and of their artists. The ISRC of a played provider
// source is known only while it is in the provider cache.
const loadPlays = Effect.fn(function* (candidates: ReadonlyArray<Candidate>, now: number) {
  const db = yield* Database;
  const sourceIds = candidates.map((candidate) => candidate.summary.id);
  const isrcs = candidates.flatMap((candidate) => candidate.isrc ?? []);
  const artists = candidates.flatMap((candidate) => candidate.summary.artist?.toLowerCase() ?? []);

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

const rankAnswers = Effect.fn(function* (query: string, answer: Answer) {
  const now = yield* Clock.currentTimeMillis;

  // A played provider source is also a local result. The local copy has the canonical fields,
  // the provider copy the ISRC and position. A provider can return an item twice.
  const byId = new Map<string, Candidate>();
  for (const candidate of answer.candidates) {
    const earlier = byId.get(candidate.summary.id);
    byId.set(
      candidate.summary.id,
      earlier === undefined ? candidate : new Candidate({ ...candidate, summary: earlier.summary }),
    );
  }
  const candidates = [...byId.values()];
  const plays = yield* loadPlays(candidates, now);

  const ranked = rank(query, candidates, answer.hits, plays, now, yield* providerOrder);
  return new SearchResults({
    sources: ranked.map((result) => result.summary),
    unavailable: answer.unavailable,
  });
});

/** The ranked sources on this replica, without providers */
export const searchCatalog = (query: string) =>
  Stream.fromEffect(
    Effect.gen(function* () {
      const local = yield* searchLocalSources(query);
      return yield* rankAnswers(
        query,
        new Answer({ candidates: local, hits: [], unavailable: [] }),
      );
    }),
  );

/**
 * The ranked sources on this replica first, then the complete ranked list again each time that a
 * provider search or a popularity source answers
 */
export const search = (query: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const popularities = yield* Popularities;
      const providers = yield* usableProviders;

      const local = yield* searchLocalSources(query);

      const providerAnswers = [...providers].flatMap(([id, { provider, credentials }]) => {
        if (provider.search === undefined) return [];

        const upload = provider.uploads === true;
        return [searchProvider(id, provider.name, provider.search, upload, credentials, query)];
      });
      const popularityAnswers = [...popularities].map(([name, popularity]) =>
        fetchPopularity(name, popularity, query).pipe(
          Effect.map((hits) => new Answer({ candidates: [], hits, unavailable: [] })),
        ),
      );

      const last = yield* Ref.make<ReadonlyArray<string>>([]);
      return Stream.fromIterable([...providerAnswers, ...popularityAnswers]).pipe(
        Stream.flatMap(Stream.fromEffect, { concurrency: "unbounded" }),
        Stream.scan(
          () => new Answer({ candidates: local, hits: [], unavailable: [] }),
          (all, next) =>
            new Answer({
              candidates: [...all.candidates, ...next.candidates],
              hits: [...all.hits, ...next.hits],
              unavailable: [...all.unavailable, ...next.unavailable],
            }),
        ),
        Stream.mapEffect((all) => rankAnswers(query, all)),
        Stream.tap((results) =>
          Ref.set(
            last,
            results.sources.slice(0, discoveredResults).map((summary) => summary.id),
          ),
        ),
        // The copies of the top results, so that the next search shows them as one song
        Stream.onEnd(Effect.flatMap(Ref.get(last), queueCopyDiscovery)),
      );
    }),
  );
