import { playEvent, providerItem, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, SearchResults } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { PopularityHit } from "@dyad/plugin";
import type { Credentials, Provider, ProviderError } from "@dyad/plugin";
import { and, eq, gte, inArray, or, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { Clock, Data, Effect, Option, Stream } from "effect";

import { normalizeIsrc } from "./normalize.ts";
import { cacheProviderSources, cachedSummary } from "./provider-cache.ts";
import { Popularities, usableProviders } from "./providers.ts";
import { Candidate, Play, playHistoryMs, rank } from "./ranking.ts";
import { playableSources, sourceSummary, tagIdentifiers } from "./sources.ts";

const localResultLimit = 50;

// One limit for the full answer of a provider search or a popularity source, with the token
// refreshes and retries of the plugin
const answerTimeout = "8 seconds";

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
    const rows = yield* playableSources(userId, match, localResultLimit);

    return rows.map((row, position) => {
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
  });

class Answer extends Data.Class<{
  readonly candidates: ReadonlyArray<Candidate>;
  readonly hits: ReadonlyArray<PopularityHit>;
  readonly unavailable: ReadonlyArray<string>;
}> {}

// A failure, a defect or a timeout of one plugin skips only that provider
const searchProvider = (
  id: string,
  name: string,
  search: NonNullable<Provider["search"]>,
  upload: boolean,
  credentials: Credentials,
  query: string,
) =>
  Effect.gen(function* () {
    const sources = yield* search(query, credentials).pipe(
      Effect.timeout(answerTimeout),
      Effect.asSome,
      Effect.catchTags({
        ProviderError: (error) =>
          Effect.logWarning("Provider search failed", error.reason).pipe(Effect.as(Option.none())),
        TimeoutError: () =>
          Effect.logWarning("Provider search timed out").pipe(Effect.as(Option.none())),
      }),
      Effect.catchDefect((defect) =>
        Effect.logError("Provider search crashed", defect).pipe(Effect.as(Option.none())),
      ),
      Effect.annotateLogs("provider", id),
    );
    if (Option.isNone(sources)) {
      return new Answer({ candidates: [], hits: [], unavailable: [name] });
    }

    const cached = yield* cacheProviderSources(id, sources.value);
    const candidates = cached.map(
      (item, position) =>
        new Candidate({
          summary: cachedSummary(item, name),
          isrc: item.isrc,
          position,
          local: false,
          lossless: item.source.lossless,
          upload,
        }),
    );
    return new Answer({ candidates, hits: [], unavailable: [] });
  });

const fetchPopularity = (
  name: string,
  popularity: (query: string) => Effect.Effect<ReadonlyArray<PopularityHit>, ProviderError>,
  query: string,
) =>
  popularity(query).pipe(
    Effect.timeout(answerTimeout),
    Effect.map((hits) =>
      hits.map(
        (hit) =>
          new PopularityHit({
            ...hit,
            isrc: hit.isrc === null ? null : normalizeIsrc(hit.isrc),
          }),
      ),
    ),
    Effect.catchTags({
      ProviderError: (error) =>
        Effect.logWarning("Popularity source failed", error.reason).pipe(Effect.as([])),
      TimeoutError: () => Effect.logWarning("Popularity source timed out").pipe(Effect.as([])),
    }),
    Effect.catchDefect((defect) =>
      Effect.logError("Popularity source crashed", defect).pipe(Effect.as([])),
    ),
    Effect.annotateLogs("popularity", name),
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

const rankAnswers = (query: string, userId: UserId, answer: Answer) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    // A played provider source is also a local result. The local copy has the canonical fields,
    // the provider copy the ISRC and position. A provider can return an item twice.
    const byId = new Map<string, Candidate>();
    for (const candidate of answer.candidates) {
      const earlier = byId.get(candidate.summary.id);
      byId.set(
        candidate.summary.id,
        earlier === undefined
          ? candidate
          : new Candidate({ ...candidate, summary: earlier.summary }),
      );
    }
    const candidates = [...byId.values()];
    const plays = yield* loadPlays(userId, candidates, now);

    const ranked = rank(query, candidates, answer.hits, plays, now);
    return new SearchResults({
      sources: ranked.map((result) => result.summary),
      unavailable: answer.unavailable,
    });
  });

/**
 * The ranked sources on this replica first, then the complete ranked list again each time that a
 * provider search or a popularity source answers
 */
export const search = (query: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const popularities = yield* Popularities;
      const providers = yield* usableProviders(principal.userId);

      const local = yield* searchLocalSources(query, principal.userId);

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
        Stream.mapEffect((all) => rankAnswers(query, principal.userId, all)),
      );
    }),
  );
