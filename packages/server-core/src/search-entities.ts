import { album, albumArtist, artist } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { AlbumCard, AlbumRef, ArtistCard, ArtistRef, catalogArtistRef } from "@dyad/domain";
import type { SourceSummary } from "@dyad/domain";
import type { ProviderArtistCard, ProviderRelease } from "@dyad/plugin";
import { and, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Column } from "drizzle-orm";
import { Array as Arr, Data, Effect, Option } from "effect";

import { albumPageRefs } from "./albums.ts";
import { artistIdOf } from "./artists.ts";
import { simplifyText, spellings } from "./normalize.ts";
import { cardTypes, releaseCard } from "./pages.ts";
import { providerArtistRef, providerRefParts } from "./refs.ts";

const shownArtists = 20;
const shownAlbums = 30;
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

/** The albums and artists of one provider answer */
export class FoundEntities extends Data.Class<{
  readonly provider: string;
  readonly upload: boolean;
  readonly releases: ReadonlyArray<ProviderRelease>;
  readonly artists: ReadonlyArray<ProviderArtistCard>;
}> {}

// Uploads are often reuploads and fan channels, so their order says less
const uploadTrust = 0.5;
// An artist or album that the catalog knows counts like a first result of a provider
const catalogWeight = 1;
// The credits and albums of the found songs count less than a direct hit
const songWeight = 0.5;

class Found<A> extends Data.Class<{
  readonly card: A;
  readonly score: number;
  readonly weight: number;
}> {}

/**
 * The artists and albums for a query from the catalog, the provider answers and the found songs,
 * best name match first. Each list that has one adds to its weight, so an artist that the catalog
 * and two providers know ranks over an artist that only one provider has.
 */
export const rankedEntities = Effect.fn("rankedEntities")(function* (
  query: string,
  catalog: Effect.Success<ReturnType<typeof catalogEntities>>,
  sources: ReadonlyArray<SourceSummary>,
  found: ReadonlyArray<FoundEntities>,
) {
  const trust = (entry: FoundEntities, position: number) =>
    (entry.upload ? uploadTrust : 1) / (1 + position);

  // Only credits with one page per name: `artist` can be a joint name with the first artist's page
  const credits = sources.flatMap((summary, position) =>
    summary.artists.flatMap((credited) =>
      credited.ref === null ? [] : [{ name: credited.name, ref: credited.ref, position }],
    ),
  );
  const hits = found.flatMap((entry) =>
    entry.artists.map((artist, position) => ({
      artist,
      ref: providerArtistRef(entry.provider, artist.externalId),
      weight: trust(entry, position),
    })),
  );
  const refs = yield* catalogRefs([
    ...new Set([...credits.map((credit) => credit.ref), ...hits.map((hit) => hit.ref)]),
  ]);

  const artists = new Map<string, Found<ArtistCard>>();
  const addArtist = (card: ArtistCard, weight: number) => {
    const earlier = artists.get(card.ref);
    if (earlier !== undefined) {
      const artworkUrl = earlier.card.artworkUrl ?? card.artworkUrl;
      artists.set(
        card.ref,
        new Found({
          ...earlier,
          card: new ArtistCard({ ...earlier.card, artworkUrl }),
          weight: earlier.weight + weight,
        }),
      );
      return;
    }
    const score = nameScore(query, card.name);
    if (score !== null) artists.set(card.ref, new Found({ card, score, weight }));
  };
  for (const { card, weight } of catalog.artists) {
    addArtist(card, catalogWeight + Math.min(weight, 50) / 50);
  }
  for (const hit of hits) {
    const ref = refs.get(hit.ref) ?? hit.ref;
    addArtist(
      new ArtistCard({ ref, name: hit.artist.name, artworkUrl: hit.artist.artworkUrl }),
      hit.weight,
    );
  }
  for (const credit of credits) {
    const ref = refs.get(credit.ref) ?? credit.ref;
    addArtist(
      new ArtistCard({ ref, name: credit.name, artworkUrl: null }),
      songWeight / (1 + credit.position),
    );
  }

  const albums = new Map<string, Found<AlbumCard>>();
  // The songs of a compilation name their own artists, so a ref that is known keeps its entry
  const keysByRef = new Map<string, string>();
  const addAlbum = (card: AlbumCard, weight: number) => {
    const key =
      keysByRef.get(card.ref) ?? `${simplifyText(card.title)}|${simplifyText(card.artist ?? "")}`;
    keysByRef.set(card.ref, key);
    const earlier = albums.get(key);
    if (earlier !== undefined) {
      const artworkUrl = earlier.card.artworkUrl ?? card.artworkUrl;
      albums.set(
        key,
        new Found({
          ...earlier,
          card: new AlbumCard({ ...earlier.card, artworkUrl }),
          weight: earlier.weight + weight,
        }),
      );
      return;
    }
    const byTitle = nameScore(query, card.title);
    const byArtist = nameScore(query, card.artist);
    // An album of the artist that the query names comes after the albums that it names
    const score = byTitle ?? (byArtist === null || byArtist > 1 ? null : 4 + byArtist);
    if (score !== null) albums.set(key, new Found({ card, score, weight }));
  };
  // The newest catalog album first among equals
  for (const { card, weight } of catalog.albums) addAlbum(card, catalogWeight + weight / 1e5);
  for (const entry of found) {
    for (const [position, release] of entry.releases.entries()) {
      addAlbum(releaseCard(entry.provider, release), trust(entry, position));
    }
  }
  for (const [position, summary] of sources.entries()) {
    if (summary.albumRef === null || summary.album === null) continue;
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
    addAlbum(card, songWeight / (1 + position));
  }

  const best = <A>(entries: Iterable<Found<A>>) =>
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
