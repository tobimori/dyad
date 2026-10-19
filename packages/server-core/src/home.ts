import { playEvent, providerPage, source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import { AlbumCard, HomeGroup, HomePage, HomeShelf, PageState, PageTrack } from "@dyad/domain";
import type { AlbumRef } from "@dyad/domain";
import { ProviderShelf, SuggestionShelf } from "@dyad/plugin";
import type { Credentials, Recommender } from "@dyad/plugin";
import { and, eq, gte, inArray } from "drizzle-orm";
import { Clock, Effect, Option, Schema, Stream } from "effect";

import { listRecentPlays } from "./history.ts";
import { libraryAlbumCards, providerPageStream, providerTracks, releaseCard } from "./pages.ts";
import { usableProviders } from "./providers.ts";
import { playHistoryMs, playValue } from "./ranking.ts";
import { RecommendationMemory, Recommenders, recommenderAccount } from "./recommenders.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { resolveSuggestions } from "./suggestions.ts";
import { Pick, choose, loadTaste } from "./taste.ts";

const shelfLimit = 20;

// Ordered by the decayed weight of their plays, like search ranking, so skips count against
const recentAlbums = Effect.gen(function* () {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;

  const plays = yield* db
    .select({
      sourceId: playEvent.sourceId,
      startedAt: playEvent.startedAt,
      playedMs: playEvent.playedMs,
      completed: playEvent.completed,
    })
    .from(playEvent)
    .where(gte(playEvent.startedAt, now - playHistoryMs));
  const rows = yield* playableSources(
    inArray(source.id, [...new Set(plays.map((play) => play.sourceId))]),
  );
  const summaries = rows.map(sourceSummary);
  const albumRefs = new Map(summaries.map((summary) => [summary.id, summary.albumRef]));

  const weights = new Map<AlbumRef, number>();
  for (const play of plays) {
    const ref = albumRefs.get(play.sourceId) ?? null;
    if (ref !== null) weights.set(ref, (weights.get(ref) ?? 0) + playValue(play, now));
  }

  const cards = new Map(
    (yield* libraryAlbumCards(summaries.map((summary) => ({ summary })))).map((card) => [
      card.ref,
      card,
    ]),
  );
  return [...weights]
    .filter(([, weight]) => weight > 0)
    .toSorted(([, a], [, b]) => b - a)
    .slice(0, shelfLimit)
    .flatMap(([ref]) => {
      const card = cards.get(ref);
      // The card would count only the played tracks
      return card === undefined ? [] : [new AlbumCard({ ...card, trackCount: null })];
    });
});

const localGroup = Effect.gen(function* () {
  const albums = yield* recentAlbums;
  const recent = yield* listRecentPlays;
  const tracks = recent
    .slice(0, shelfLimit)
    .map((summary) => new PageTrack({ source: summary, disc: null, number: null, playable: true }));

  return new HomeGroup({
    providerName: null,
    shelves: [
      new HomeShelf({ title: "Recent albums", tracks: [], albums }),
      new HomeShelf({ title: "Recently played", tracks, albums: [] }),
    ].filter((shelf) => shelf.tracks.length > 0 || shelf.albums.length > 0),
    state: new PageState({ status: "local", fetchedAt: null, reason: null }),
  });
});

const providerGroup = (provider: string) =>
  providerPageStream("home", { provider, externalId: "" }, Schema.Array(ProviderShelf), {
    fetch: (plugin) => {
      const home = plugin.home;
      return home === undefined
        ? undefined
        : (_: string, credentials: Credentials) => home(credentials);
    },
    tracks: (shelves) => shelves.flatMap((shelf) => shelf.tracks),
    build: (page) =>
      Effect.gen(function* () {
        const shelves = yield* Effect.forEach(page.data ?? [], (shelf) =>
          Effect.gen(function* () {
            return new HomeShelf({
              title: shelf.title,
              tracks: yield* providerTracks(page.provider, page.providerName, shelf.tracks),
              albums: shelf.releases.map((release) => releaseCard(page.provider, release)),
            });
          }),
        );
        return new HomeGroup({ providerName: page.providerName, shelves, state: page.state });
      }).pipe(orDieOnDatabaseError("homePage")),
  });

// One account request per refresh on YouTube Music, so at most 4 a day. A failed fetch waits too.
const personalLifetimeMs = 6 * 60 * 60 * 1000;
const forYouLimit = 25;
// Searches for suggestions without a source, per build
const forYouSearches = 8;
const PersonalShelves = Schema.Array(SuggestionShelf);

const forYouShelves = (
  linked: ReadonlyArray<{
    readonly id: string;
    readonly recommender: Recommender;
    readonly shelves: ReadonlyArray<SuggestionShelf>;
  }>,
  searches: number,
  state: PageState,
) =>
  Effect.gen(function* () {
    const items = linked
      .flatMap(({ id, recommender, shelves }) =>
        shelves.flatMap((shelf) =>
          shelf.songs.map((suggestion, position) => ({
            suggestion,
            recommender: id,
            score: (recommender.priority ?? 0) / 100 + 0.5 / (1 + position),
            reason: `From ${shelf.title} on ${recommender.name}`,
          })),
        ),
      )
      .toSorted((a, b) => b.score - a.score);
    const found = yield* resolveSuggestions(items, searches);
    const picks = items.flatMap((item, index) => {
      const summary = found[index];
      return summary === undefined ? [] : [new Pick({ ...item, summary })];
    });
    const songs = choose(yield* loadTaste, picks, {
      exclude: new Set(),
      limit: forYouLimit,
      explainArtist: true,
    });

    const releases = linked.flatMap(({ id, shelves }) =>
      shelves.flatMap((shelf) =>
        shelf.releases.length === 0
          ? []
          : [
              new HomeShelf({
                title: shelf.title,
                tracks: [],
                albums: shelf.releases.map((release) => releaseCard(id, release)),
              }),
            ],
      ),
    );
    return new HomeGroup({
      providerName: null,
      shelves: [new HomeShelf({ title: "For you", tracks: songs, albums: [] }), ...releases].filter(
        (shelf) => shelf.tracks.length > 0 || shelf.albums.length > 0,
      ),
      state,
    });
  });

/**
 * The suggestions of the user's linked recommenders, merged and ranked by the user's plays. The
 * cached shelves first, then again after a refresh of the shelves older than 6 hours.
 */
const forYouGroup = (
  linked: ReadonlyArray<{
    readonly id: string;
    readonly recommender: Recommender;
    readonly credentials: Credentials;
  }>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const db = yield* Database;
      const memory = yield* RecommendationMemory;
      const now = yield* Clock.currentTimeMillis;

      const cached = yield* Effect.forEach(linked, (entry) =>
        Effect.gen(function* () {
          const [row] = yield* db
            .select({ data: providerPage.data, fetchedAt: providerPage.fetchedAt })
            .from(providerPage)
            .where(
              and(
                eq(providerPage.provider, entry.id),
                eq(providerPage.kind, "personal"),
                eq(providerPage.externalId, ""),
              ),
            );
          const shelves = Option.getOrElse(
            row === undefined
              ? Option.none()
              : Schema.decodeUnknownOption(PersonalShelves)(row.data),
            () => [],
          );
          const lastTry = Math.max(row?.fetchedAt ?? 0, memory.attempts.get(entry.id) ?? 0);
          return { ...entry, shelves, stale: now - lastTry >= personalLifetimeMs };
        }),
      );
      const stale = cached.filter((entry) => entry.stale);
      const state = (status: PageState["status"], reason: string | null = null) =>
        new PageState({ status, fetchedAt: null, reason });

      const refresh = Effect.forEach(cached, (entry) =>
        Effect.gen(function* () {
          if (!entry.stale || entry.recommender.shelves === undefined) return entry;
          memory.attempts.set(entry.id, now);
          const shelves = yield* entry.recommender.shelves(entry.credentials).pipe(
            Effect.timeout("20 seconds"),
            Effect.asSome,
            Effect.catchTags({
              ProviderError: (error) =>
                Effect.logWarning("Personal shelves failed", error.reason).pipe(
                  Effect.as(Option.none()),
                ),
              TimeoutError: () =>
                Effect.logWarning("Personal shelves timed out").pipe(Effect.as(Option.none())),
            }),
            Effect.catchDefect((defect) =>
              Effect.logError("Personal shelves crashed", defect).pipe(Effect.as(Option.none())),
            ),
            Effect.annotateLogs("recommender", entry.id),
          );
          if (Option.isNone(shelves)) return entry;

          const values = {
            provider: entry.id,
            kind: "personal" as const,
            externalId: "",
            data: yield* Schema.encodeEffect(PersonalShelves)(shelves.value).pipe(Effect.orDie),
            fetchedAt: now,
          };
          yield* db
            .insert(providerPage)
            .values(values)
            .onConflictDoUpdate({
              target: [providerPage.provider, providerPage.kind, providerPage.externalId],
              set: values,
            });
          return { ...entry, shelves: shelves.value };
        }),
      );

      // The first build searches nothing, so that the home page shows at once
      const first = forYouShelves(cached, 0, state(stale.length === 0 ? "fresh" : "fetching")).pipe(
        orDieOnDatabaseError("homePage"),
      );
      const second = refresh.pipe(
        Effect.flatMap((fetched) => forYouShelves(fetched, forYouSearches, state("fresh"))),
        orDieOnDatabaseError("homePage"),
      );
      return Stream.concat(Stream.fromEffect(first), Stream.fromEffect(second));
    }).pipe(orDieOnDatabaseError("homePage")),
  );

/** The user's plays first, then the suggestions for the user, then each usable provider's home */
export const homePage = Stream.unwrap(
  Effect.gen(function* () {
    const providers = yield* usableProviders;
    const recommenders = yield* Recommenders;
    const groups = [...providers].flatMap(([id, usable]) =>
      usable.provider.home === undefined ? [] : [providerGroup(id)],
    );

    const linked = yield* Effect.forEach(
      [...recommenders].filter(([, recommender]) => recommender.shelves !== undefined),
      ([id, recommender]) =>
        Effect.map(recommenderAccount(id), (account) =>
          Option.map(account, ({ credentials }) => ({ id, recommender, credentials })),
        ),
    ).pipe(Effect.map((accounts) => accounts.flatMap(Option.toArray)));
    // `zipLatestAll` waits for every stream, so a group without recommenders is left out
    const forYou = linked.length === 0 ? [] : [forYouGroup(linked)];

    const local = Stream.fromEffect(localGroup.pipe(orDieOnDatabaseError("homePage")));
    return Stream.zipLatestAll(local, ...forYou, ...groups).pipe(
      Stream.map((latest) => new HomePage({ groups: latest })),
    );
  }).pipe(orDieOnDatabaseError("homePage")),
);
