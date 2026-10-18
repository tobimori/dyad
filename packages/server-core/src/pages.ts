import { localFile } from "@dyad/db";
import {
  AlbumCard,
  AlbumPage,
  AlbumSection,
  ArtistCard,
  ArtistPage,
  CurrentPrincipal,
  PageNotFound,
  PageState,
  PageTrack,
  ReleaseType,
  SecondaryType,
  SourceSummary,
  TrackSection,
} from "@dyad/domain";
import type { AlbumRef, ArtistRef } from "@dyad/domain";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Data, Effect, Option, Schema } from "effect";

import { albumArtistOf } from "./library.ts";
import { libraryAlbumKeys, libraryArtistKey, libraryArtistRef } from "./refs.ts";
import { Tags, playableSources, position, sourceSummary } from "./sources.ts";

// Library pages come from the tags of the files on this replica. Binding will replace them with
// catalog pages that resolve the same `library:` refs through `local_key`.

const localState = new PageState({ status: "local", fetchedAt: null, reason: null });

class LibraryFile extends Data.Class<{
  readonly summary: SourceSummary;
  readonly tags: typeof Tags.Type;
  readonly albumArtistKey: string | null;
  readonly albumKey: string | null;
}> {}

// One entry per source. A source with several files gives the tags of one of them.
const libraryFiles = (match: SQL | undefined) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const rows = yield* playableSources(principal.userId, and(isNotNull(localFile.id), match));

    return rows.map(
      (row) =>
        new LibraryFile({
          summary: sourceSummary(row),
          tags: row.tags ?? {},
          albumArtistKey: row.albumArtistKey,
          albumKey: row.albumKey,
        }),
    );
  });

// Files without a key are left out
const groupFiles = <K>(files: ReadonlyArray<LibraryFile>, key: (file: LibraryFile) => K | null) => {
  const groups = new Map<K, Array<LibraryFile>>();
  for (const file of files) {
    const fileKey = key(file);
    if (fileKey === null) continue;

    const group = groups.get(fileKey) ?? [];
    group.push(file);
    groups.set(fileKey, group);
  }
  return groups;
};

// The most common spelling, so that one file with another spelling does not rename the group
const mostCommon = (values: ReadonlyArray<string | undefined>) => {
  const counts = new Map<string, number>();
  for (const value of values) {
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }

  const [best] = [...counts].toSorted(
    ([a, countA], [b, countB]) => countB - countA || a.localeCompare(b),
  );
  return best?.[0] ?? null;
};

const datePrefix = /^\d{4}(-\d{2}(-\d{2})?)?/;

// FFmpeg (`node-av` 6.1.1) keeps the ID3v2.4 frame name `TDOR` as the key of an MP3 original date
const releaseDateOf = (tags: typeof Tags.Type) =>
  (tags.originaldate ?? tags.tdor ?? tags.date)?.match(datePrefix)?.[0];

// Picard writes `releasetype`, for example `album; compilation`. FFmpeg (`node-av` 6.1.1) gives the
// MP3 frame `TXXX:MusicBrainz Album Type` the key `musicbrainz album type`.
const releaseTypeOf = (tags: typeof Tags.Type) =>
  tags.releasetype ?? tags["musicbrainz album type"];

const albumCard = (ref: AlbumRef, files: ReadonlyArray<LibraryFile>) => {
  const tags = files.map((file) => file.tags);
  const types = (mostCommon(tags.map(releaseTypeOf)) ?? "")
    .toLowerCase()
    .split(/[;/]/)
    .map((type) => type.trim());
  const compilation = tags.some((fileTags) => fileTags.compilation === "1");
  const albumArtistKey = files[0]?.albumArtistKey ?? null;

  return new AlbumCard({
    ref,
    title: mostCommon(tags.map((fileTags) => fileTags.album)) ?? "",
    artist: mostCommon(tags.map(albumArtistOf)),
    artistRef: albumArtistKey === null ? null : libraryArtistRef(albumArtistKey),
    releaseDate: tags.flatMap((fileTags) => releaseDateOf(fileTags) ?? []).toSorted()[0] ?? null,
    primaryType: types.find(Schema.is(ReleaseType)) ?? null,
    secondaryTypes: SecondaryType.literals.filter(
      (type) => types.includes(type) || (type === "compilation" && compilation),
    ),
    explicit: false,
    trackCount: files.length,
    artworkUrl: null,
  });
};

const albumCards = (files: ReadonlyArray<LibraryFile>) =>
  [...groupFiles(files, (file) => file.summary.albumRef)].map(([ref, group]) =>
    albumCard(ref, group),
  );

const sectionKind = (album: AlbumCard) => {
  if (album.secondaryTypes.includes("compilation")) return "compilations";
  if (album.secondaryTypes.includes("live")) return "live";
  if (album.primaryType === "single" || album.primaryType === "ep") return "singles_eps";
  if (album.primaryType === "album") return "albums";
  return "other";
};

// Library and provider pages give the same order: newest first, albums without a date last
const newestFirst = (a: AlbumCard, b: AlbumCard) =>
  (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title);

const releaseKinds = ["albums", "singles_eps", "compilations", "live", "other"] as const;

const releaseSections = (albums: ReadonlyArray<AlbumCard>) =>
  releaseKinds.flatMap((kind) => {
    const section = albums.filter((album) => sectionKind(album) === kind).toSorted(newestFirst);
    return section.length === 0 ? [] : [new AlbumSection({ kind, albums: section })];
  });

const pageTracks = (files: ReadonlyArray<LibraryFile>) =>
  files
    .map(
      (file) =>
        new PageTrack({
          source: file.summary,
          disc: position(file.tags, "disc"),
          number: position(file.tags, "track"),
          playable: true,
        }),
    )
    .toSorted(
      (a, b) =>
        (a.disc ?? 1) - (b.disc ?? 1) ||
        (a.number ?? 0) - (b.number ?? 0) ||
        (a.source.title ?? "").localeCompare(b.source.title ?? ""),
    );

/** The album artists of the files on this replica, by name */
export const listLibraryArtists = Effect.gen(function* () {
  const files = yield* libraryFiles(isNotNull(localFile.albumArtistKey));

  return [...groupFiles(files, (file) => file.albumArtistKey)]
    .map(
      ([key, group]) =>
        new ArtistCard({
          ref: libraryArtistRef(key),
          name: mostCommon(group.map((file) => albumArtistOf(file.tags))) ?? key,
          artworkUrl: null,
        }),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));
});

/** The albums of the files on this replica, by artist and title */
export const listLibraryAlbums = Effect.gen(function* () {
  const files = yield* libraryFiles(
    and(isNotNull(localFile.albumArtistKey), isNotNull(localFile.albumKey)),
  );

  return albumCards(files).toSorted(
    (a, b) => (a.artist ?? "").localeCompare(b.artist ?? "") || a.title.localeCompare(b.title),
  );
});

/**
 * The albums of the album artist, the albums where the artist has tracks, and the artist's tracks
 * without an album
 */
export const artistPage = (ref: ArtistRef) =>
  Effect.gen(function* () {
    const key = libraryArtistKey(ref);
    if (Option.isNone(key)) return yield* new PageNotFound();

    const files = yield* libraryFiles(
      or(eq(localFile.albumArtistKey, key.value), eq(localFile.artistKey, key.value)),
    );
    if (files.length === 0) return yield* new PageNotFound();

    const own = files.filter((file) => file.albumArtistKey === key.value);
    const guest = files.filter((file) => file.albumArtistKey !== key.value);

    // All tracks of these albums, so that their cards count the tracks of the other artists too
    const guestAlbums = new Set(guest.flatMap((file) => file.summary.albumRef ?? []));
    const guestAlbumFiles = yield* libraryFiles(
      and(
        inArray(
          localFile.albumArtistKey,
          guest.flatMap((file) => file.albumArtistKey ?? []),
        ),
        inArray(
          localFile.albumKey,
          guest.flatMap((file) => file.albumKey ?? []),
        ),
      ),
    );
    const appearsOn = albumCards(
      guestAlbumFiles.filter(
        (file) => file.summary.albumRef !== null && guestAlbums.has(file.summary.albumRef),
      ),
    ).toSorted(newestFirst);

    const looseTracks = pageTracks(own.filter((file) => file.albumKey === null));

    return new ArtistPage({
      ref: libraryArtistRef(key.value),
      providerName: null,
      name:
        mostCommon(own.map((file) => albumArtistOf(file.tags))) ??
        mostCommon(guest.map((file) => file.tags.artist)),
      artworkUrl: null,
      sections: [
        ...releaseSections(albumCards(own)),
        ...(appearsOn.length === 0
          ? []
          : [new AlbumSection({ kind: "appears_on", albums: appearsOn })]),
        ...(looseTracks.length === 0
          ? []
          : [new TrackSection({ kind: "tracks", tracks: looseTracks })]),
      ],
      state: localState,
    });
  });

/** The tracks of the album in disc and track order */
export const albumPage = (ref: AlbumRef) =>
  Effect.gen(function* () {
    const keys = libraryAlbumKeys(ref);
    if (Option.isNone(keys)) return yield* new PageNotFound();

    const [albumArtistKey, albumKey] = keys.value;
    const files = yield* libraryFiles(
      and(eq(localFile.albumArtistKey, albumArtistKey), eq(localFile.albumKey, albumKey)),
    );
    const [album] = albumCards(files);
    if (album === undefined) return yield* new PageNotFound();

    return new AlbumPage({
      ref: album.ref,
      providerName: null,
      album,
      tracks: pageTracks(files),
      state: localState,
    });
  });
