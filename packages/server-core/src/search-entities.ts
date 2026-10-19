import { album, albumArtist, artist } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { AlbumCard, AlbumRef, ArtistCard, ArtistRef, catalogArtistRef } from "@dyad/domain";
import type { SourceSummary } from "@dyad/domain";
import { and, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { Array as Arr, Effect, Option } from "effect";

import { albumPageRefs } from "./albums.ts";
import { artistIdOf } from "./artists.ts";
import { simplifyText, spellings } from "./normalize.ts";
import { cardTypes } from "./pages.ts";
import { providerRefParts } from "./refs.ts";

const shownArtists = 5;
const shownAlbums = 8;
const scanLimit = 50;

// Lower is better: the same name, then a name that starts with the query, then one that contains
// it, then a name that the query contains, for example `Madonna` in `madonna danceteria`
const nameScore = (query: string, name: string | null) => {
  const wanted = simplifyText(query);
  const found = simplifyText(name ?? "");
  if (wanted === "" || found === "") return null;
  if (found === wanted) return 0;
  if (found.startsWith(wanted)) return 1;
  if (` ${found} `.includes(` ${wanted}`)) return 2;
  if (found.length >= 3 && ` ${wanted} `.includes(` ${found} `)) return 3;
  return null;
};

const scanned = (column: Column, query: string) =>
  or(
    ...spellings(query).map(
      (spelling) =>
        sql`${column} like ${`%${spelling.replaceAll(/[\\%_]/g, "\\$&")}%`} escape '\\'`,
    ),
  );

/** The catalog artists and albums whose names contain the query, before the ranking */
export const catalogEntities = Effect.fn("catalogEntities")(function* (query: string) {
  const db = yield* Database;
  const member = sql`coalesce(m.merged_into_id, m.id) = ${artist.id}`;
  const artists = yield* db
    .select({
      id: artist.id,
      name: artist.name,
      songs: sql<number>`(
        SELECT count(*) FROM song_artist AS n JOIN artist AS m ON m.id = n.artist_id WHERE ${member}
      )`,
    })
    .from(artist)
    .where(
      and(
        isNull(artist.mergedIntoId),
        scanned(artist.name, query),
        // The same page rule as `playableSources`
        sql`EXISTS (SELECT 1 FROM artist AS m WHERE ${member} AND m.origin = 'provider')`,
      ),
    )
    .limit(scanLimit);

  const credited = sql`(
    SELECT coalesce(a.merged_into_id, a.id) FROM ${albumArtist} AS c JOIN ${artist} AS a ON a.id = c.artist_id
    WHERE c.album_id = ${album.id} AND c.position = 0
  )`;
  const albums = yield* db
    .select({ album, artistRoot: sql<string | null>`${credited}` })
    .from(album)
    .where(
      and(
        isNull(album.mergedIntoId),
        isNotNull(album.title),
        or(scanned(album.title, query), scanned(album.artistName, query)),
      ),
    )
    .limit(scanLimit);
  const refs = yield* albumPageRefs(albums.map((row) => row.album.id));

  return {
    artists: artists.map((row) => ({
      card: new ArtistCard({
        ref: catalogArtistRef(row.id),
        name: row.name ?? "",
        artworkUrl: null,
      }),
      weight: row.songs,
    })),
    albums: albums.flatMap(({ album: row, artistRoot }) => {
      const ref = refs.get(row.id);
      if (ref === undefined || row.title === null) return [];
      const card = new AlbumCard({
        ref: AlbumRef.make(ref),
        title: row.title,
        artist: row.artistName,
        artistRef: artistRoot === null ? null : catalogArtistRef(artistRoot),
        releaseDate: row.year === null ? null : String(row.year),
        ...cardTypes(row.type),
        explicit: false,
        trackCount: null,
        artworkUrl: row.artworkUrl,
      });
      return [{ card, weight: row.year ?? 0 }];
    }),
  };
});

// The provider artists of the found songs, as catalog refs where the catalog knows them
const catalogRefs = Effect.fn(function* (refs: ReadonlyArray<ArtistRef>) {
  const db = yield* Database;
  const ids = yield* Effect.forEach(refs, (ref) =>
    Option.match(providerRefParts(ref), {
      onNone: () => Effect.succeed({ ref, id: Option.none<string>() }),
      onSome: (parts) =>
        artistIdOf(parts.provider, parts.externalId).pipe(
          Effect.map((id) => ({ ref, id: Option.some(id) })),
        ),
    }),
  );
  const known = ids.flatMap((entry) => Option.toArray(entry.id));
  const roots = new Map(
    known.length === 0
      ? []
      : (yield* db
          .select({
            id: artist.id,
            root: sql<string>`coalesce(${artist.mergedIntoId}, ${artist.id})`,
          })
          .from(artist)
          .where(inArray(artist.id, known))).map((row) => [row.id, row.root]),
  );
  return new Map(
    ids.map(({ ref, id }) => {
      const root = Option.getOrUndefined(Option.flatMapNullishOr(id, (known) => roots.get(known)));
      return [ref, root === undefined ? ref : catalogArtistRef(root)] as const;
    }),
  );
});

/**
 * The artists and albums for a query: catalog matches and the artists and albums of the found
 * songs, best name match first
 */
export const rankedEntities = Effect.fn("rankedEntities")(function* (
  query: string,
  catalog: Effect.Success<ReturnType<typeof catalogEntities>>,
  sources: ReadonlyArray<SourceSummary>,
) {
  // Only credits with one page per name: `artist` can be a joint name with the first artist's page
  const credits = sources.flatMap((summary, position) =>
    summary.artists.flatMap((credited) =>
      credited.ref === null ? [] : [{ name: credited.name, ref: credited.ref, position }],
    ),
  );
  const refs = yield* catalogRefs([...new Set(credits.map((credit) => credit.ref))]);

  // Catalog entries first; the found songs add the ones that the catalog does not have
  const artists = new Map<string, { card: ArtistCard; score: number; weight: number }>();
  for (const { card, weight } of catalog.artists) {
    const score = nameScore(query, card.name);
    if (score !== null) artists.set(card.ref, { card, score, weight });
  }
  for (const credit of credits) {
    const ref = refs.get(credit.ref) ?? credit.ref;
    const score = nameScore(query, credit.name);
    if (score === null || artists.has(ref)) continue;
    const card = new ArtistCard({ ref, name: credit.name, artworkUrl: null });
    artists.set(ref, { card, score, weight: -credit.position });
  }

  const albums = new Map<string, { card: AlbumCard; score: number; weight: number }>();
  const albumKey = (card: AlbumCard) =>
    `${simplifyText(card.title)}|${simplifyText(card.artist ?? "")}`;
  for (const { card, weight } of catalog.albums) {
    const byTitle = nameScore(query, card.title);
    const byArtist = nameScore(query, card.artist);
    // An album of the artist that the query names comes after the albums that it names
    const score = byTitle ?? (byArtist === null || byArtist > 1 ? null : 4 + byArtist);
    if (score !== null && !albums.has(albumKey(card))) {
      albums.set(albumKey(card), { card, score, weight });
    }
  }
  for (const [position, summary] of sources.entries()) {
    const score = nameScore(query, summary.album);
    if (score === null || summary.albumRef === null || summary.album === null) continue;
    const card = new AlbumCard({
      ref: summary.albumRef,
      title: summary.album,
      artist: summary.artist,
      artistRef: summary.artistRef,
      releaseDate: null,
      primaryType: null,
      secondaryTypes: [],
      explicit: summary.explicit,
      trackCount: null,
      artworkUrl: summary.artworkUrl,
    });
    if (!albums.has(albumKey(card))) albums.set(albumKey(card), { card, score, weight: -position });
  }

  const best = <A>(entries: Iterable<{ card: A; score: number; weight: number }>) =>
    [...entries]
      .toSorted((a, b) => a.score - b.score || b.weight - a.weight)
      .map((entry) => entry.card);
  // Two artists can share a name, but a list of the same name twice does not help to choose
  const named = Arr.dedupeWith(
    best(artists.values()),
    (a, b) => simplifyText(a.name) === simplifyText(b.name),
  );
  return {
    artists: named.slice(0, shownArtists),
    albums: best(albums.values()).slice(0, shownAlbums),
  };
});
