import {
  album,
  albumArtist,
  artist,
  catalogAssertion,
  edition,
  editionTrack,
  entityMerge,
  recording,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { ProviderAlbum } from "@dyad/plugin";
import { and, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import { Array as Arr, Effect, Schema } from "effect";

import { creditNames, creditedArtists, projectArtistRows, sameNames } from "./artists.ts";
import { ArtistCredit, assertFields, resolveField } from "./assertions.ts";
import { AlbumType, ReleaseDate } from "./editions.ts";
import { boundRecordingId, upcEditionId, uuidV5 } from "./ids.ts";
import { effectiveTarget, followEdges, writeSystemMerge } from "./matching.ts";
import { Providers } from "./providers.ts";

const EditionTrack = Schema.Struct({
  disc: Schema.Int,
  position: Schema.Int,
  /** The bound recording of the plugin track */
  recordingId: Schema.String,
  externalId: Schema.String,
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
});

/** Stored field names of an edition, and the schema of their values */
export const editionFields = {
  title: Schema.String,
  album_id: Schema.String,
  artist_credit: ArtistCredit,
  date: ReleaseDate,
  album_type: AlbumType,
  artwork_url: Schema.String,
  upc: Schema.String,
  label: Schema.String,
  tracks: Schema.Array(EditionTrack),
};

// The share of the songs of the smaller album that the other album must have
const sameAlbumShare = 0.8;

// Only these words make another edition of the same album, never Live, Remix or Instrumental
const editionSuffix =
  /\s*(?:[([]([^()[\]]*\b(?:deluxe|expanded|remaster(?:ed)?|anniversary|special|bonus tracks?(?: version)?)\b[^()[\]]*)[)\]]|\s-\s((?:[^-]*\b)?(?:deluxe|expanded|remaster(?:ed)?|anniversary|special)\b[^-]*))$/i;

/** The title without its edition words, and the words, for example `Deluxe Edition` */
export const splitEdition = (title: string) => {
  const words: Array<string> = [];
  let base = title;
  for (let match = editionSuffix.exec(base); match !== null; match = editionSuffix.exec(base)) {
    words.unshift((match[1] ?? match[2] ?? "").trim());
    base = base.slice(0, match.index);
  }
  return base === "" ? { base: title, words: null } : { base, words: words.join(" · ") || null };
};

const albumTypeOf = (type: typeof AlbumType.Type | null) => {
  if (type === null) return null;
  if (type.secondary.includes("compilation")) return "compilation" as const;
  if (type.secondary.includes("live")) return "live" as const;
  return type.primary;
};

/**
 * Sets `merged_into_id` and `status` of the albums or editions whose root can change with the
 * edges of `ids`. A merge can arrive before the facts, so it makes missing rows. Returns the
 * affected IDs.
 */
const resolveGroups = (entityType: "album" | "edition", ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const table = entityType === "album" ? album : edition;

    yield* db
      .insert(table)
      .values(ids.map((id) => ({ id, origin: "provider" as const, policyVersion: 1, revision: 0 })))
      .onConflictDoNothing();
    const current = yield* db
      .select({ id: table.id, mergedIntoId: table.mergedIntoId })
      .from(table)
      .where(inArray(table.id, ids));
    const seeds = [...new Set([...ids, ...current.flatMap((row) => row.mergedIntoId ?? [])])];
    const members = yield* db
      .select({ id: table.id, mergedIntoId: table.mergedIntoId })
      .from(table)
      .where(inArray(table.mergedIntoId, seeds));

    const targets = new Map<string, string | null>();
    const rootOf = followEdges((id) =>
      Effect.gen(function* () {
        const known = targets.get(id);
        if (known !== undefined) return known;
        const edges = yield* db
          .select()
          .from(entityMerge)
          .where(and(eq(entityMerge.entityType, entityType), eq(entityMerge.fromId, id)));
        const target = effectiveTarget(edges);
        targets.set(id, target);
        return target;
      }),
    );

    const affected = new Set(seeds);
    const rows = new Map([...current, ...members].map((row) => [row.id, row]));
    yield* Effect.forEach(
      rows.values(),
      (row) =>
        Effect.gen(function* () {
          const root = yield* rootOf(row.id);
          const mergedIntoId = root === row.id ? null : root;
          affected.add(row.id).add(root);
          if (row.mergedIntoId === mergedIntoId) return;
          yield* db
            .update(table)
            .set({ mergedIntoId, status: mergedIntoId === null ? "active" : "merged" })
            .where(eq(table.id, row.id));
        }),
      { discard: true },
    );
    return [...affected];
  });

/**
 * Makes each album and its root from root editions: a root from the editions of all its members,
 * a merged album from its own
 */
const projectAlbums = (albumIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;
    const ids = [...new Set(albumIds)];
    if (ids.length === 0) return;

    yield* db
      .insert(album)
      .values(ids.map((id) => ({ id, origin: "provider" as const, policyVersion: 1, revision: 0 })))
      .onConflictDoNothing();
    const known = yield* db
      .select({ id: album.id, root: album.mergedIntoId })
      .from(album)
      .where(inArray(album.id, ids));
    const roots = [...new Set(known.map((row) => row.root ?? row.id))];
    const members = yield* db
      .select({ id: album.id, root: album.mergedIntoId })
      .from(album)
      .where(inArray(album.mergedIntoId, roots));
    const rootOf = new Map([
      ...roots.map((id) => [id, id] as const),
      ...members.map((row) => [row.id, row.root ?? row.id] as const),
    ]);
    const merged = known.filter((row) => row.root !== null).map((row) => row.id);

    const editions = yield* db
      .select()
      .from(edition)
      .where(and(inArray(edition.albumId, [...rootOf.keys()]), isNull(edition.mergedIntoId)));
    // A root edition resolves over the editions merged into it
    const editionRootOf = new Map([
      ...editions.map((row) => [row.id, row.id] as const),
      ...(yield* db
        .select({ id: edition.id, root: edition.mergedIntoId })
        .from(edition)
        .where(
          inArray(
            edition.mergedIntoId,
            editions.map((row) => row.id),
          ),
        )).map((row) => [row.id, row.root ?? row.id] as const),
    ]);
    const assertions = yield* db
      .select()
      .from(catalogAssertion)
      .where(
        and(
          eq(catalogAssertion.entityType, "edition"),
          inArray(catalogAssertion.entityId, [...editionRootOf.keys()]),
          inArray(catalogAssertion.field, ["album_type", "artist_credit"]),
          eq(catalogAssertion.retracted, false),
        ),
      );
    const credits = new Map(
      editions.map((row) => [
        row.id,
        assertions.filter(
          (assertion) =>
            assertion.field === "artist_credit" && editionRootOf.get(assertion.entityId) === row.id,
        ),
      ]),
    );
    yield* projectArtistRows([...credits.values()].flatMap(creditedArtists));
    const existing = Arr.groupBy(
      yield* db
        .select()
        .from(albumArtist)
        .where(inArray(albumArtist.albumId, [...roots, ...merged]))
        .orderBy(albumArtist.albumId, albumArtist.position),
      (row) => row.albumId,
    );

    yield* Effect.forEach(
      [...roots, ...merged],
      (id) =>
        Effect.gen(function* () {
          const own = editions.filter((row) =>
            merged.includes(id) ? row.albumId === id : rootOf.get(row.albumId ?? "") === id,
          );
          // The original edition: the earliest date, then the one without edition words
          const original = own.toSorted(
            (a, b) =>
              Number(a.date === null) - Number(b.date === null) ||
              (a.date ?? "").localeCompare(b.date ?? "") ||
              Number(a.editionWords !== null) - Number(b.editionWords !== null) ||
              a.id.localeCompare(b.id),
          )[0];
          const editionIds = new Set(own.map((row) => row.id));
          const type = resolveField(
            providers,
            assertions.filter(
              (assertion) =>
                assertion.field === "album_type" &&
                editionIds.has(editionRootOf.get(assertion.entityId) ?? ""),
            ),
            "album_type",
            AlbumType,
          );
          const names = yield* creditNames(providers, credits.get(original?.id ?? "") ?? []);
          if (!sameNames(existing[id] ?? [], names)) {
            yield* db.delete(albumArtist).where(eq(albumArtist.albumId, id));
            if (names.length > 0) {
              yield* db.insert(albumArtist).values(names.map((name) => ({ albumId: id, ...name })));
            }
          }
          yield* db
            .update(album)
            .set({
              title: original?.title == null ? null : splitEdition(original.title).base,
              artistName: original?.artistName ?? null,
              type: albumTypeOf(type),
              year: original?.date == null ? null : Number(original.date.slice(0, 4)),
              artworkUrl: original?.artworkUrl ?? null,
            })
            .where(eq(album.id, id));
        }),
      { discard: true },
    );
  });

/**
 * Makes the edition rows and their tracks from the assertions, then their albums. A root
 * resolves over the assertions of all editions merged into it. Returns the album IDs.
 */
const projectEditions = (editionIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;
    const ids = [...new Set(editionIds)];
    if (ids.length === 0) return [];

    yield* db
      .insert(edition)
      .values(ids.map((id) => ({ id, origin: "provider" as const, policyVersion: 1, revision: 0 })))
      .onConflictDoNothing();
    const rows = yield* db.select().from(edition).where(inArray(edition.id, ids));
    const merged = yield* db
      .select({ id: edition.id, root: edition.mergedIntoId })
      .from(edition)
      .where(inArray(edition.mergedIntoId, ids));
    const assertions = yield* db
      .select()
      .from(catalogAssertion)
      .where(
        and(
          eq(catalogAssertion.entityType, "edition"),
          inArray(catalogAssertion.entityId, [...ids, ...merged.map((row) => row.id)]),
          eq(catalogAssertion.retracted, false),
        ),
      );

    const albums = new Set(rows.flatMap((row) => row.albumId ?? []));
    yield* Effect.forEach(
      rows,
      (row) =>
        Effect.gen(function* () {
          const members = new Set([
            row.id,
            ...merged.filter((member) => member.root === row.id).map((member) => member.id),
          ]);
          const own = assertions.filter((assertion) => members.has(assertion.entityId));
          const field = <F extends keyof typeof editionFields>(name: F) =>
            resolveField<(typeof editionFields)[F]["Type"]>(
              providers,
              own,
              name,
              editionFields[name],
            );
          const title = field("title");
          const credit = field("artist_credit");
          const values = {
            albumId: field("album_id"),
            title,
            editionWords: title === null ? null : splitEdition(title).words,
            artistName: credit?.name ?? null,
            date: field("date"),
            label: field("label"),
            upc: field("upc"),
            artworkUrl: field("artwork_url"),
          };
          yield* db.update(edition).set(values).where(eq(edition.id, row.id));
          if (values.albumId !== null) albums.add(values.albumId);

          // A merged edition shows the tracks of its root
          const tracks = row.mergedIntoId === null ? (field("tracks") ?? []) : [];
          yield* db.delete(editionTrack).where(eq(editionTrack.editionId, row.id));
          if (tracks.length === 0) return;
          yield* db.insert(editionTrack).values(
            tracks.map((track) => ({
              id: `${row.id}:track:${track.disc}:${track.position}`,
              editionId: row.id,
              disc: track.disc,
              position: track.position,
              recordingId: track.recordingId,
              title: track.title,
              artistName: track.artist,
              durationMs: track.durationMs,
            })),
          );
        }),
      { discard: true },
    );
    yield* projectAlbums(albums);
    return [...albums];
  });

/** Follows arriving merges and assertions of albums and editions */
export const deriveAlbums = (input: {
  readonly editions: ReadonlyArray<string>;
  readonly albumMerges: ReadonlyArray<string>;
  readonly editionMerges: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const editions =
      input.editionMerges.length === 0 ? [] : yield* resolveGroups("edition", input.editionMerges);
    yield* projectEditions([...input.editions, ...editions]);
    if (input.albumMerges.length > 0) {
      yield* projectAlbums(yield* resolveGroups("album", input.albumMerges));
    }
  });

// Same UPC, same edition: the plugin edition goes into the UPC edition
const matchUpc = (editionId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ upc: edition.upc })
      .from(edition)
      .where(eq(edition.id, editionId));
    if (row?.upc == null) return [];
    const into = yield* upcEditionId(row.upc);
    const changed = yield* writeSystemMerge({
      entityType: "edition",
      fromId: editionId,
      intoId: into,
      decision: "merge",
      method: "upc",
      confidence: 0.95,
      evidence: { upc: row.upc },
    });
    return changed ? [editionId, into] : [];
  });

// Root recordings of the tracks of the root editions of each root album
const songsOf = (albumIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select({
        album: sql<string>`coalesce(${album.mergedIntoId}, ${album.id})`,
        song: sql<string>`coalesce(${recording.mergedIntoId}, ${editionTrack.recordingId})`,
      })
      .from(editionTrack)
      .innerJoin(edition, eq(edition.id, editionTrack.editionId))
      .innerJoin(album, eq(album.id, edition.albumId))
      .leftJoin(recording, eq(recording.id, editionTrack.recordingId))
      .where(sql`coalesce(${album.mergedIntoId}, ${album.id}) in ${albumIds}`);
    const songs = new Map<string, Set<string>>();
    for (const row of rows) songs.set(row.album, (songs.get(row.album) ?? new Set()).add(row.song));
    return songs;
  });

/**
 * The edition rule: two albums are one album when they have the same album artist, the same
 * title without edition words, no other stated type, and most songs of the smaller one
 */
const matchAlbum = (albumId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [known] = yield* db.select().from(album).where(eq(album.id, albumId));
    const [row] =
      known?.mergedIntoId == null
        ? [known]
        : yield* db.select().from(album).where(eq(album.id, known.mergedIntoId));
    if (row?.title == null) return [];

    // The first album artist, as its root
    const artistRoot = sql<string>`coalesce(${artist.mergedIntoId}, ${albumArtist.artistId})`;
    const firstArtist = and(eq(albumArtist.albumId, album.id), eq(albumArtist.position, 0));
    const [owner] = yield* db
      .select({ root: artistRoot })
      .from(album)
      .innerJoin(albumArtist, firstArtist)
      .leftJoin(artist, eq(artist.id, albumArtist.artistId))
      .where(eq(album.id, row.id));
    if (owner?.root == null) return [];
    const candidates = yield* db
      .select({ id: album.id, type: album.type })
      .from(album)
      .innerJoin(albumArtist, firstArtist)
      .leftJoin(artist, eq(artist.id, albumArtist.artistId))
      .where(
        and(
          isNull(album.mergedIntoId),
          ne(album.id, row.id),
          sql`lower(${album.title}) = ${row.title.toLowerCase()}`,
          sql`${artistRoot} = ${owner.root}`,
        ),
      );
    const fitting = candidates.filter(
      (candidate) => candidate.type === null || row.type === null || candidate.type === row.type,
    );
    if (fitting.length === 0) return [];

    const songs = yield* songsOf([row.id, ...fitting.map((candidate) => candidate.id)]);
    const own = songs.get(row.id) ?? new Set<string>();
    const changed = yield* Effect.forEach(fitting, (candidate) => {
      const other = songs.get(candidate.id) ?? new Set<string>();
      const shared = [...own].filter((song) => other.has(song)).length;
      const smaller = Math.min(own.size, other.size);
      if (smaller === 0 || shared / smaller < sameAlbumShare) return Effect.succeed(false);
      return writeSystemMerge({
        entityType: "album",
        fromId: candidate.id < row.id ? row.id : candidate.id,
        intoId: candidate.id < row.id ? candidate.id : row.id,
        decision: "merge",
        method: "edition_rule",
        confidence: 0.8,
        evidence: { shared: String(shared), smaller: String(smaller) },
      });
    });
    return changed.some(Boolean) ? [row.id, ...fitting.map((candidate) => candidate.id)] : [];
  });

/**
 * Runs the edition rule again for the albums with these recordings, after a song merge changed the
 * shared songs. Only the replica that merged decides; the others follow the merges.
 */
export const matchAlbumsOf = (recordingIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const ids = [...new Set(recordingIds)];
    if (ids.length === 0) return;
    const albums = yield* db
      .selectDistinct({ id: sql<string>`coalesce(${album.mergedIntoId}, ${album.id})` })
      .from(editionTrack)
      .innerJoin(edition, eq(edition.id, editionTrack.editionId))
      .innerJoin(album, eq(album.id, edition.albumId))
      .where(inArray(editionTrack.recordingId, ids));
    const albumMerges = (yield* Effect.forEach(albums, (row) => matchAlbum(row.id))).flat();
    yield* deriveAlbums({ editions: [], albumMerges, editionMerges: [] });
  });

/**
 * Asserts the edition of a provider album and its tracks, then matches it by UPC and by the
 * edition rule. A track without a number has no position, so it is not a track of the edition.
 */
export const assertEdition = (provider: string, data: ProviderAlbum) =>
  Effect.gen(function* () {
    const release = data.release;
    const id = yield* uuidV5(`${provider}:edition:${release.externalId}`);
    const tracks = yield* Effect.forEach(
      data.tracks.filter((track) => track.number !== null),
      (track) =>
        Effect.gen(function* () {
          const source = track.source;
          return EditionTrack.make({
            disc: track.disc ?? 1,
            position: track.number ?? 0,
            recordingId: yield* boundRecordingId(provider, source.externalId),
            externalId: source.externalId,
            title: source.title,
            artist: source.artist,
            durationMs: source.durationMs,
          });
        }),
    );

    const changed = yield* assertFields(
      "edition",
      id,
      "provider",
      `${provider}:${release.externalId}`,
      {
        title: release.title,
        album_id: yield* uuidV5(`${provider}:album:${release.externalId}`),
        artist_credit:
          release.artist === null
            ? null
            : { name: release.artist, artists: [{ id: release.artistId, name: release.artist }] },
        date: release.releaseDate,
        album_type: { primary: release.primaryType, secondary: release.secondaryTypes },
        artwork_url: release.artworkUrl,
        upc: release.upc,
        label: release.label,
        tracks,
      },
      {},
    );
    if (!changed) return;

    const albums = yield* projectEditions([id]);
    const editionMerges = yield* matchUpc(id);
    const albumMerges = (yield* Effect.forEach(albums, matchAlbum)).flat();
    yield* deriveAlbums({ editions: [], albumMerges, editionMerges });
  });
