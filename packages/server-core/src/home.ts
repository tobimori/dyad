import { playEvent, source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  AlbumCard,
  CurrentPrincipal,
  HomeGroup,
  HomePage,
  HomeShelf,
  PageState,
  PageTrack,
} from "@dyad/domain";
import type { AlbumRef } from "@dyad/domain";
import { ProviderShelf } from "@dyad/plugin";
import type { Credentials } from "@dyad/plugin";
import { and, eq, gte, inArray } from "drizzle-orm";
import { Clock, Effect, Schema, Stream } from "effect";

import { listRecentPlays } from "./history.ts";
import { libraryAlbumCards, providerPageStream, providerTracks, releaseCard } from "./pages.ts";
import { usableProviders } from "./providers.ts";
import { playHistoryMs, playValue } from "./ranking.ts";
import { playableSources, sourceSummary } from "./sources.ts";

const shelfLimit = 20;

// Ordered by the decayed weight of their plays, like search ranking, so skips count against
const recentAlbums = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;
  const now = yield* Clock.currentTimeMillis;

  const plays = yield* db
    .select({
      sourceId: playEvent.sourceId,
      startedAt: playEvent.startedAt,
      playedMs: playEvent.playedMs,
      completed: playEvent.completed,
    })
    .from(playEvent)
    .where(
      and(eq(playEvent.userId, principal.userId), gte(playEvent.startedAt, now - playHistoryMs)),
    );
  const rows = yield* playableSources(
    principal.userId,
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
    libraryAlbumCards(summaries.map((summary) => ({ summary }))).map((card) => [card.ref, card]),
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
  providerPageStream(
    "home",
    // One cache row per provider, because the shelves do not depend on the user
    { provider, externalId: "" },
    Schema.Array(ProviderShelf),
    {
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
        }),
    },
  );

/** The user's plays first, then each provider that the user can use and that has a home */
export const homePage = Stream.unwrap(
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const providers = yield* usableProviders(principal.userId);
    const groups = [...providers].flatMap(([id, usable]) =>
      usable.provider.home === undefined ? [] : [providerGroup(id)],
    );

    const local = Stream.fromEffect(localGroup.pipe(orDieOnDatabaseError("homePage")));
    return Stream.zipLatestAll(local, ...groups).pipe(
      Stream.map((latest) => new HomePage({ groups: latest })),
    );
  }).pipe(orDieOnDatabaseError("homePage")),
);
