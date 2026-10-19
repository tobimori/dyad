import {
  album,
  albumArtist,
  artist,
  edition,
  editionTrack,
  identifier,
  localFile,
  providerItem,
  providerPage,
  recording,
  songArtist,
} from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  AlbumCard,
  AlbumPage,
  AlbumSection,
  ArtistCard,
  ArtistPage,
  ArtistRef,
  ArtistSection,
  PageNotFound,
  PageState,
  PageTrack,
  SourceSummary,
  TrackSection,
  catalogArtistRef,
  compareSources,
} from "@dyad/domain";
import { AlbumRef } from "@dyad/domain";
import { ProviderAlbum, ProviderArtist, ProviderSource } from "@dyad/plugin";
import type {
  Credentials,
  Provider,
  ProviderError,
  ProviderRelease,
  ProviderTrack,
} from "@dyad/plugin";
import { artistNameKey } from "@dyad/plugin/tracklist";
import { and, eq, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Clock, Context, Data, Effect, Layer, Option, Ref, Schema, Stream } from "effect";

import {
  albumEditions,
  albumPageRefs,
  assertEdition,
  queueEditions,
  splitEdition,
} from "./albums.ts";
import { linkFoundArtists } from "./artist-matching.ts";
import { artistIdOf } from "./artists.ts";
import { uuidV5 } from "./ids.ts";
import { normV1, simplifyText, withoutGuests } from "./normalize.ts";
import { albumTypeOf, tagReleaseDate, tagReleaseTypes } from "./editions.ts";
import { albumArtistOf } from "./library.ts";
import { cacheProviderSources, cachedSummary, toCachedSource } from "./provider-cache.ts";
import { Providers, callProvider, linkedProviders, usableProviders } from "./providers.ts";
import {
  catalogArtistId,
  libraryAlbumKeys,
  libraryArtistKey,
  libraryArtistRef,
  providerAlbumRef,
  providerArtistRef,
  providerRefParts,
} from "./refs.ts";
import { Tags, playableSources, position, sourceSummary } from "./sources.ts";
import { sameNamedSong } from "./ranking.ts";
import { providerOrder } from "./source-preference.ts";
import { listLibrary, songEntries } from "./user-library.ts";

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
const libraryFiles = Effect.fn(function* (match: SQL | undefined) {
  const rows = yield* playableSources(and(isNotNull(localFile.id), match));

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

// Items without a key are left out
const groupBy = <T, K>(items: ReadonlyArray<T>, key: (item: T) => K | null) => {
  const groups = new Map<K, Array<T>>();
  for (const item of items) {
    const itemKey = key(item);
    if (itemKey === null) continue;

    const group = groups.get(itemKey) ?? [];
    group.push(item);
    groups.set(itemKey, group);
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

const albumCard = (ref: AlbumRef, files: ReadonlyArray<LibraryFile>) => {
  const tags = files.map((file) => file.tags);
  const type = albumTypeOf(
    mostCommon(tags.map(tagReleaseTypes)) ?? undefined,
    tags.some((fileTags) => fileTags.compilation === "1"),
  );
  const albumArtistKey = files[0]?.albumArtistKey ?? null;

  return new AlbumCard({
    ref,
    title: mostCommon(tags.map((fileTags) => fileTags.album)) ?? "",
    artist: mostCommon(tags.map(albumArtistOf)),
    artistRef: albumArtistKey === null ? null : libraryArtistRef(albumArtistKey),
    releaseDate: tags.flatMap((fileTags) => tagReleaseDate(fileTags) ?? []).toSorted()[0] ?? null,
    primaryType: type.primary,
    secondaryTypes: type.secondary,
    explicit: false,
    trackCount: files.length,
    artworkUrl: null,
  });
};

const albumCards = (files: ReadonlyArray<LibraryFile>) =>
  [...groupBy(files, (file) => file.summary.albumRef)].map(([ref, group]) => albumCard(ref, group));

// Library and provider pages give the same order: newest first, albums without a date last
const newestFirst = (a: AlbumCard, b: AlbumCard) =>
  (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "") || a.title.localeCompare(b.title);

// One mixed discography: the type shows on each card, not as a section
const releaseSections = (albums: ReadonlyArray<AlbumCard>) =>
  albums.length === 0
    ? []
    : [new AlbumSection({ kind: "discography", albums: albums.toSorted(newestFirst) })];

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

class LibrarySource extends Data.Class<{
  readonly summary: SourceSummary;
  readonly artistName: string | null;
}> {}

// The saved songs with a copy of a linked provider, one copy each. It reads only replicated rows,
// because a device has no provider cache. Local files have their own cards.
const librarySources = Effect.gen(function* () {
  const db = yield* Database;
  const providers = yield* linkedProviders;
  const summaries = (yield* listLibrary).flatMap((entry) =>
    entry.source !== null &&
    entry.source.provider !== "local" &&
    providers.has(entry.source.provider)
      ? [entry.source]
      : [],
  );

  // The first credited name, as the artist card shows it
  const ids = [...new Set(summaries.flatMap((summary) => summary.recordingId ?? []))];
  const bound = alias(recording, "bound");
  const names = new Map(
    ids.length === 0
      ? []
      : (yield* db
          .select({ id: bound.id, name: songArtist.name })
          .from(bound)
          .innerJoin(
            songArtist,
            and(
              eq(songArtist.recordingId, sql`coalesce(${bound.mergedIntoId}, ${bound.id})`),
              eq(songArtist.position, 0),
            ),
          )
          .where(inArray(bound.id, ids))).map((row) => [row.id, row.name]),
  );
  return summaries.map(
    (summary) =>
      new LibrarySource({
        summary,
        artistName: names.get(summary.recordingId ?? "") ?? summary.artist,
      }),
  );
});

const libraryArtistCards = (sources: ReadonlyArray<LibrarySource>) =>
  [...groupBy(sources, (item) => item.summary.artistRef)].map(
    ([ref, group]) =>
      new ArtistCard({
        ref,
        name: mostCommon(group.map((item) => item.artistName ?? undefined)) ?? "",
        artworkUrl: null,
      }),
  );

// The card types of an album type. A DJ mix and a broadcast have no card type yet.
const cardTypes = (type: typeof album.$inferSelect.type) => {
  if (type === "compilation" || type === "live") {
    return { primaryType: "album" as const, secondaryTypes: [type] };
  }
  if (type === "album" || type === "ep" || type === "single") {
    return { primaryType: type, secondaryTypes: [] };
  }
  return { primaryType: null, secondaryTypes: [] };
};

/**
 * One card for each album of the given tracks. A track without an album groups by its provider
 * album. The card counts the given tracks and opens the provider album of most of them.
 */
export const libraryAlbumCards = Effect.fn("libraryAlbumCards")(function* (
  sources: ReadonlyArray<Pick<LibrarySource, "summary">>,
) {
  const db = yield* Database;
  const ids = [...new Set(sources.flatMap((item) => item.summary.recordingId ?? []))];
  const bound = alias(recording, "bound");
  const memberAlbum = alias(album, "member_album");
  const albums = new Map(
    ids.length === 0
      ? []
      : (yield* db
          .select({ id: bound.id, album })
          .from(bound)
          .innerJoin(recording, eq(recording.id, sql`coalesce(${bound.mergedIntoId}, ${bound.id})`))
          .innerJoin(memberAlbum, eq(memberAlbum.id, recording.albumId))
          .innerJoin(
            album,
            eq(album.id, sql`coalesce(${memberAlbum.mergedIntoId}, ${memberAlbum.id})`),
          )
          .where(inArray(bound.id, ids))).map((row) => [row.id, row.album]),
  );
  const albumOf = (item: Pick<LibrarySource, "summary">) =>
    albums.get(item.summary.recordingId ?? "");

  const groups = groupBy(sources, (item) => {
    const found = albumOf(item);
    return found === undefined ? item.summary.albumRef : `album:${found.id}`;
  });
  // A device has no provider cache, so its tracks have no album ref
  const pageRefs = yield* albumPageRefs([...new Set([...albums.values()].map((row) => row.id))]);
  return [...groups.values()].flatMap((group) => {
    const [first] = group;
    const found = first === undefined ? undefined : albumOf(first);
    const ref =
      mostCommon(group.map((item) => item.summary.albumRef ?? undefined)) ??
      (found === undefined ? null : (pageRefs.get(found.id) ?? null));
    if (ref === null) return [];
    const artistRef = mostCommon(group.map((item) => item.summary.artistRef ?? undefined));
    const artworkUrl =
      group.find((item) => item.summary.artworkUrl !== null)?.summary.artworkUrl ?? null;
    const shared = {
      ref: AlbumRef.make(ref),
      artistRef: artistRef === null ? null : ArtistRef.make(artistRef),
      explicit: group.some((item) => item.summary.explicit),
      trackCount: group.length,
    };
    if (found?.title != null) {
      return [
        new AlbumCard({
          ...shared,
          title: found.title,
          artist: found.artistName,
          releaseDate: found.year === null ? null : String(found.year),
          ...cardTypes(found.type),
          artworkUrl: found.artworkUrl ?? artworkUrl,
        }),
      ];
    }
    return [
      new AlbumCard({
        ...shared,
        // A release without an album name is a single, for example on Bandcamp
        title:
          mostCommon(group.map((item) => item.summary.album ?? undefined)) ??
          mostCommon(group.map((item) => item.summary.title ?? undefined)) ??
          "",
        artist: mostCommon(group.map((item) => item.summary.artist ?? undefined)),
        releaseDate: null,
        primaryType: null,
        secondaryTypes: [],
        artworkUrl,
      }),
    ];
  });
});

/** The album artists of the files on this replica and the artists of the provider library */
export const listLibraryArtists = Effect.gen(function* () {
  const files = yield* libraryFiles(isNotNull(localFile.albumArtistKey));
  const saved = yield* librarySources;

  const local = [...groupBy(files, (file) => file.albumArtistKey)].map(
    ([key, group]) =>
      new ArtistCard({
        ref: libraryArtistRef(key),
        name: mostCommon(group.map((file) => albumArtistOf(file.tags))) ?? key,
        artworkUrl: null,
      }),
  );
  return [...local, ...libraryArtistCards(saved)].toSorted((a, b) => a.name.localeCompare(b.name));
});

/** The albums of the files on this replica and of the provider library, by artist and title */
export const listLibraryAlbums = Effect.gen(function* () {
  const files = yield* libraryFiles(
    and(isNotNull(localFile.albumArtistKey), isNotNull(localFile.albumKey)),
  );
  const saved = yield* librarySources;

  return [...albumCards(files), ...(yield* libraryAlbumCards(saved))].toSorted(
    (a, b) => (a.artist ?? "").localeCompare(b.artist ?? "") || a.title.localeCompare(b.title),
  );
});

// The albums of the album artist, the albums where the artist has tracks, and the artist's tracks
// without an album
const localArtistPage = Effect.fn(function* (ref: ArtistRef) {
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

// The tracks of the album in disc and track order
const localAlbumPage = Effect.fn(function* (ref: AlbumRef) {
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

// Like search results, a track of a page enters the shared catalog only when it is played
const pageLifetimeMs = 24 * 60 * 60 * 1000;

// Apple pages need a request for each view with more than 10 releases. A home page shows its
// cached shelves while it fetches, and Hype Machine paces a request for each track.
const fetchTimeouts = { artist: "20 seconds", album: "20 seconds", home: "60 seconds" } as const;

export const providerTracks = Effect.fn("providerTracks")(function* (
  provider: string,
  providerName: string,
  tracks: ReadonlyArray<ProviderTrack>,
) {
  const providers = yield* Providers;
  return yield* Effect.forEach(tracks, (track) =>
    Effect.gen(function* () {
      const item = yield* toCachedSource(track.provider ?? provider, track.source);
      return new PageTrack({
        source: yield* cachedSummary(
          item,
          track.provider === null
            ? providerName
            : (providers.get(track.provider)?.name ?? track.provider),
        ),
        disc: track.disc,
        number: track.number,
        playable: track.streamable,
      });
    }),
  );
});

export const releaseCard = (provider: string, release: ProviderRelease) =>
  new AlbumCard({
    ref: providerAlbumRef(provider, release.externalId),
    title: release.title,
    artist: release.artist,
    artistRef: release.artistId === null ? null : providerArtistRef(provider, release.artistId),
    releaseDate: release.releaseDate,
    primaryType: release.primaryType,
    secondaryTypes: release.secondaryTypes,
    explicit: release.explicit,
    trackCount: release.trackCount,
    artworkUrl: release.artworkUrl,
  });

class PageInput<A> extends Data.Class<{
  readonly provider: string;
  readonly providerName: string;
  // `null` before the first fetch
  readonly data: A | null;
  readonly library: ReadonlyArray<LibrarySource>;
  readonly state: PageState;
}> {}

/** Fetches a provider page, then caches it with its tracks and writes its facts */
export const fetchProviderPage = Effect.fn("fetchProviderPage")(function* <A, E, R>(
  kind: "artist" | "album" | "home",
  parts: { readonly provider: string; readonly externalId: string },
  schema: Schema.Codec<A, E>,
  fetch: Effect.Effect<A, ProviderError>,
  options: {
    readonly tracks: (data: A) => ReadonlyArray<ProviderTrack>;
    readonly facts?: (data: A) => Effect.Effect<void, never, R>;
  },
) {
  const db = yield* Database;
  // Before the tracks, so that every track of the page is at least as new as the page
  const fetchedAt = yield* Clock.currentTimeMillis;
  const data = yield* fetch.pipe(Effect.timeout(fetchTimeouts[kind]));
  const tracks = options.tracks(data);
  yield* cacheProviderSources(
    parts.provider,
    tracks.flatMap((track) => (track.provider === null ? [track.source] : [])),
  );
  // Tracks of other providers do not replace their richer copies
  const others = new Set(tracks.flatMap((track) => track.provider ?? []));
  yield* Effect.forEach(
    others,
    (other) =>
      cacheProviderSources(
        other,
        tracks.flatMap((track) => (track.provider === other ? [track.source] : [])),
        { keepKnown: true },
      ),
    { discard: true },
  );
  const values = {
    ...parts,
    kind,
    data: yield* Schema.encodeEffect(schema)(data).pipe(Effect.orDie),
    fetchedAt,
  };
  yield* db
    .insert(providerPage)
    .values(values)
    .onConflictDoUpdate({
      target: [providerPage.provider, providerPage.kind, providerPage.externalId],
      set: values,
    });
  if (options.facts !== undefined) yield* options.facts(data);
  return { data, fetchedAt };
});

/** The cached page at once, then the fetched page when the cache is older than a day */
export const providerPageStream = <A, E, Page, R>(
  kind: "artist" | "album" | "home",
  parts: { readonly provider: string; readonly externalId: string },
  schema: Schema.Codec<A, E>,
  options: {
    readonly fetch: (
      plugin: Provider,
    ) =>
      | ((externalId: string, credentials: Credentials) => Effect.Effect<A, ProviderError>)
      | undefined;
    readonly tracks: (data: A) => ReadonlyArray<ProviderTrack>;
    /** Writes the facts of a fetched page */
    readonly facts?: (data: A) => Effect.Effect<void, never, R>;
    readonly build: (page: PageInput<A>) => Effect.Effect<Page, never, R>;
  },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const db = yield* Database;
      const plugins = yield* Providers;
      const { provider, externalId } = parts;
      const plugin = plugins.get(provider);
      const providerName = plugin?.name ?? provider;
      const library = yield* librarySources;

      const emit = (data: A | null, state: PageState) =>
        options.build(new PageInput({ provider, providerName, data, library, state }));
      const failed = (reason: string) =>
        Stream.fromEffect(emit(null, new PageState({ status: "failed", fetchedAt: null, reason })));

      if (plugin === undefined) return failed("No plugin gives this page");
      // Cached pages too, because the tracks of a page play only with the user's credentials
      const usable = (yield* usableProviders).get(provider);
      if (usable === undefined) {
        return failed(`Link your ${providerName} account to see this page`);
      }
      const fetch = options.fetch(plugin);
      if (fetch === undefined) return failed(`${providerName} has no ${kind} pages`);

      const [row] = yield* db
        .select({ data: providerPage.data, fetchedAt: providerPage.fetchedAt })
        .from(providerPage)
        .where(
          and(
            eq(providerPage.provider, provider),
            eq(providerPage.kind, kind),
            eq(providerPage.externalId, externalId),
          ),
        );
      // A row that an older plugin version wrote can fail to decode. Then the page is fetched again.
      const cached =
        row === undefined ? Option.none() : Schema.decodeUnknownOption(schema)(row.data);
      const cachedData = Option.getOrNull(cached);
      const cachedAt = Option.isSome(cached) && row !== undefined ? row.fetchedAt : null;

      const now = yield* Clock.currentTimeMillis;
      if (cachedAt !== null && now - cachedAt < pageLifetimeMs) {
        return Stream.fromEffect(
          emit(cachedData, new PageState({ status: "fresh", fetchedAt: cachedAt, reason: null })),
        );
      }

      const unreachable = emit(
        cachedData,
        new PageState({
          status: "failed",
          fetchedAt: cachedAt,
          reason: `Cannot reach ${providerName}`,
        }),
      );
      const refresh = fetchProviderPage(
        kind,
        parts,
        schema,
        fetch(externalId, usable.credentials),
        options,
      ).pipe(
        Effect.flatMap(({ data, fetchedAt }) =>
          emit(data, new PageState({ status: "fresh", fetchedAt, reason: null })),
        ),
        Effect.catchTags({
          ProviderError: (error) =>
            Effect.logWarning("Provider page failed", error.reason).pipe(
              Effect.andThen(unreachable),
            ),
          TimeoutError: () =>
            Effect.logWarning("Provider page timed out").pipe(Effect.andThen(unreachable)),
        }),
        Effect.catchDefect((defect) =>
          Effect.logError("Provider page crashed", defect).pipe(Effect.andThen(unreachable)),
        ),
        Effect.annotateLogs("provider", provider),
        orDieOnDatabaseError(`${kind}Page`),
      );

      return Stream.concat(
        Stream.fromEffect(
          emit(
            cachedData,
            new PageState({ status: "fetching", fetchedAt: cachedAt, reason: null }),
          ),
        ),
        Stream.fromEffect(refresh),
      );
    }).pipe(orDieOnDatabaseError(`${kind}Page`)),
  );

/**
 * The Dyad artist page: the catalog albums and songs of the artist and the provider pages of all
 * provider artists in its merge group, as one discography and one song list. A library ref gives
 * the page of the local files. After the first page, a search by name can link more provider
 * artists, and then the page shows them too.
 */
export const artistPage = (ref: ArtistRef) =>
  Option.isSome(libraryArtistKey(ref))
    ? Stream.fromEffect(localArtistPage(ref).pipe(orDieOnDatabaseError("artistPage")))
    : Stream.unwrap(
        Effect.gen(function* () {
          const group = yield* groupOf(ref);
          if (group === null) return Stream.fail(new PageNotFound());

          const last = yield* Ref.make(Option.none<ArtistPage>());
          const linked = Stream.unwrap(
            Effect.gen(function* () {
              const page = yield* Ref.get(last);
              if (Option.isNone(page) || !(yield* linkByName(group, page.value))) {
                return Stream.empty;
              }
              const joined = yield* groupOf(ref);
              return joined === null ? Stream.empty : groupPage(joined);
            }).pipe(orDieOnDatabaseError("artistPage")),
          );
          return Stream.concat(
            groupPage(group).pipe(Stream.tap((page) => Ref.set(last, Option.some(page)))),
            linked,
          );
        }).pipe(orDieOnDatabaseError("artistPage")),
      );

// The merge group of an artist ref. A provider artist without a catalog row is a group of one.
const groupOf = Effect.fn(function* (ref: ArtistRef) {
  const db = yield* Database;
  const parts = Option.getOrNull(providerRefParts(ref));
  const requested =
    parts === null
      ? Option.getOrNull(catalogArtistId(ref))
      : yield* artistIdOf(parts.provider, parts.externalId);
  if (requested === null) return null;

  const [row] = yield* db
    .select({ mergedIntoId: artist.mergedIntoId })
    .from(artist)
    .where(eq(artist.id, requested));
  if (row === undefined && parts === null) return null;
  const root = row?.mergedIntoId ?? requested;
  const identified = yield* db
    .select({ provider: identifier.scheme, externalId: identifier.value })
    .from(artist)
    .innerJoin(
      identifier,
      and(eq(identifier.entityType, "artist"), eq(identifier.entityId, artist.id)),
    )
    .where(sql`coalesce(${artist.mergedIntoId}, ${artist.id}) = ${root}`);
  const members = [
    ...new Map(
      [...(parts === null ? [] : [parts]), ...identified].map((member) => [
        `${member.provider}:${member.externalId}`,
        member,
      ]),
    ).values(),
  ];
  // A provider artist without a catalog row keeps its own ref
  return { ref: row === undefined ? ref : catalogArtistRef(root), root, members };
});

type ArtistGroup = NonNullable<Effect.Success<ReturnType<typeof groupOf>>>;

const groupPage = (group: ArtistGroup) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const usable = yield* usableProviders;
      const providers = yield* Providers;
      // The provider with the highest metadata priority first
      const priority = (provider: string) => providers.get(provider)?.metadataPriority ?? 0;
      const hasPage = (provider: string) => usable.get(provider)?.provider.artist !== undefined;
      const pages = group.members
        .filter((member) => hasPage(member.provider))
        .toSorted(
          (a, b) =>
            priority(b.provider) - priority(a.provider) ||
            a.provider.localeCompare(b.provider) ||
            a.externalId.localeCompare(b.externalId),
        )
        .map((member) =>
          providerPageStream("artist", member, ProviderArtist, {
            fetch: (plugin) => plugin.artist,
            tracks: (data) => [...data.topTracks, ...data.tracks],
            build: Effect.succeed,
          }),
        );

      const catalog = yield* catalogArtist(
        group.root,
        group.members.filter((member) => usable.has(member.provider) && !hasPage(member.provider)),
      );
      const uploads = new Set(
        [...usable].flatMap(([id, entry]) => (entry.provider.uploads === true ? [id] : [])),
      );
      const latest = pages.length === 0 ? Stream.succeed([]) : Stream.zipLatestAll(...pages);
      return latest.pipe(
        // All editions and tracks of the discography, from providers that allow it in the background
        Stream.tap((found) =>
          Effect.forEach(
            found,
            (page) =>
              usable.get(page.provider)?.provider.userRequestsOnly === true
                ? Effect.void
                : queueEditions(
                    page.provider,
                    [...(page.data?.releases ?? []), ...(page.data?.appearsOn ?? [])].map(
                      (release) => release.externalId,
                    ),
                  ).pipe(orDieOnDatabaseError("queueEditions")),
            { discard: true },
          ),
        ),
        Stream.mapEffect((found) =>
          mixedArtistPage(group.ref, group.root, catalog, found, uploads, priority).pipe(
            orDieOnDatabaseError("artistPage"),
          ),
        ),
      );
    }).pipe(orDieOnDatabaseError("artistPage")),
  );

// Two songs, so that one song with a common title does not link two artists of the same name
const minSharedSongs = 2;

/** When each group root was last searched by name on each provider, by `<root>:<provider>` */
export class ArtistSearches extends Context.Service<ArtistSearches, Map<string, number>>()(
  "@dyad/server-core/ArtistSearches",
) {}

export const artistSearchesLayer = Layer.sync(ArtistSearches, () => new Map());

// An artist without a match on a provider is searched again after a day, not on each page open
const artistSearchLifetimeMs = 24 * 60 * 60 * 1000;

// Searches the curated providers that the group lacks for the name of the page. A found artist
// joins the group when it is the only one of its provider with the name and at least
// `minSharedSongs` songs of the page. A name alone never links.
const linkByName = Effect.fn(function* (group: ArtistGroup, page: ArtistPage) {
  const songs = page.sections.flatMap((section) =>
    Schema.is(TrackSection)(section) ? section.tracks.map((track) => track.source) : [],
  );
  const [member] = group.members;
  const name = page.name;
  if (name === null || member === undefined || songs.length < minSharedSongs) return false;

  const usable = yield* usableProviders;
  const searches = yield* ArtistSearches;
  const now = yield* Clock.currentTimeMillis;
  const searchedRecently = (provider: string) =>
    now - (searches.get(`${group.root}:${provider}`) ?? -Infinity) < artistSearchLifetimeMs;
  const known = new Set(group.members.map((entry) => entry.provider));
  const key = artistNameKey(name);
  const upload = (provider: string) => usable.get(provider)?.provider.uploads === true;
  const found = yield* Effect.forEach(
    [...usable],
    ([provider, entry]) =>
      Effect.gen(function* () {
        const { search } = entry.provider;
        if (
          search === undefined ||
          entry.provider.artist === undefined ||
          upload(provider) ||
          known.has(provider) ||
          searchedRecently(provider)
        ) {
          return [];
        }
        searches.set(`${group.root}:${provider}`, now);
        const results = Option.getOrElse(
          yield* callProvider("Artist search", "8 seconds", search(name, entry.credentials)),
          () => [],
        );
        const candidates = [
          ...new Set(
            results.flatMap((result) =>
              result.artists.flatMap((named) =>
                artistNameKey(named.name) === key ? [named.id] : [],
              ),
            ),
          ),
        ].slice(0, 3);
        const scored = yield* Effect.forEach(candidates, (externalId) =>
          Effect.gen(function* () {
            const fetched = yield* Stream.runLast(
              providerPageStream("artist", { provider, externalId }, ProviderArtist, {
                fetch: (plugin) => plugin.artist,
                tracks: (data) => [...data.topTracks, ...data.tracks],
                build: Effect.succeed,
              }),
            );
            const data = Option.getOrNull(fetched)?.data;
            const tracks = yield* providerTracks(provider, entry.provider.name, [
              ...(data?.topTracks ?? []),
              ...(data?.tracks ?? []),
            ]);
            const shared = songs.filter((song) =>
              tracks.some((track) =>
                sameNamedSong(
                  { summary: song, upload: upload(song.provider) },
                  { summary: track.source, upload: false },
                ),
              ),
            ).length;
            return { scheme: provider, externalId, shared };
          }),
        );
        const proven = scored.filter((candidate) => candidate.shared >= minSharedSongs);
        return proven.length === 1 ? proven : [];
      }).pipe(Effect.annotateLogs("provider", provider)),
    { concurrency: "unbounded" },
  );
  return yield* linkFoundArtists(
    { scheme: member.provider, externalId: member.externalId },
    found.flat(),
  );
});

// The albums with the artist as first album artist, the songs that credit the artist, and the
// cached results of the provider artists without a page, for example a YouTube channel
const catalogArtist = Effect.fn(function* (
  root: string,
  pageless: ReadonlyArray<{ readonly provider: string; readonly externalId: string }>,
) {
  const db = yield* Database;
  const providers = yield* Providers;
  const [named] = yield* db.select({ name: artist.name }).from(artist).where(eq(artist.id, root));

  const cachedRows =
    pageless.length === 0
      ? []
      : yield* db
          .select({ provider: providerItem.provider, data: providerItem.data })
          .from(providerItem)
          .where(
            or(
              ...pageless.map((member) =>
                and(
                  eq(providerItem.provider, member.provider),
                  sql`(json_extract(${providerItem.data}, '$.uploader.id') = ${member.externalId}
                      OR exists (SELECT 1 FROM json_each(${providerItem.data}, '$.artists')
                        WHERE json_extract(value, '$.id') = ${member.externalId}))`,
                ),
              ),
            ),
          );
  const cached = yield* Effect.forEach(cachedRows, (row) =>
    Schema.decodeUnknownEffect(ProviderSource)(row.data).pipe(
      Effect.orDie,
      Effect.flatMap((source) => toCachedSource(row.provider, source)),
    ),
  );
  const ids = new Set(pageless.map((member) => member.externalId));
  const cachedName = cached
    .flatMap(({ source }) => [
      ...source.artists.filter((credited) => ids.has(credited.id)),
      ...(source.uploader !== null && ids.has(source.uploader.id) ? [source.uploader] : []),
    ])
    .at(0)?.name;
  const cachedSongs = yield* Effect.forEach(cached, (item) =>
    Effect.gen(function* () {
      return new PageTrack({
        source: yield* cachedSummary(item, providers.get(item.provider)?.name ?? item.provider),
        disc: null,
        number: null,
        playable: true,
      });
    }),
  );

  const credited = alias(artist, "credited");
  const albums = yield* db
    .select({ album })
    .from(album)
    .innerJoin(albumArtist, and(eq(albumArtist.albumId, album.id), eq(albumArtist.position, 0)))
    .leftJoin(credited, eq(credited.id, albumArtist.artistId))
    .where(
      and(
        isNull(album.mergedIntoId),
        isNotNull(album.title),
        sql`coalesce(${credited.mergedIntoId}, ${albumArtist.artistId}) = ${root}`,
      ),
    );
  const albumIds = albums.map((row) => row.album.id);
  const refs = yield* albumPageRefs(albumIds);

  // The songs of each album, for the track count and the single rule
  const tracks =
    albumIds.length === 0
      ? []
      : yield* db
          .selectDistinct({
            album: sql<string>`coalesce(${album.mergedIntoId}, ${album.id})`,
            song: sql<string>`coalesce(${recording.mergedIntoId}, ${editionTrack.recordingId})`,
          })
          .from(editionTrack)
          .innerJoin(edition, eq(edition.id, editionTrack.editionId))
          .innerJoin(album, eq(album.id, edition.albumId))
          .leftJoin(recording, eq(recording.id, editionTrack.recordingId))
          .where(
            and(
              isNull(edition.mergedIntoId),
              sql`coalesce(${album.mergedIntoId}, ${album.id}) in ${albumIds}`,
            ),
          );
  const songsOf = new Map<string, Set<string>>();
  for (const track of tracks) {
    songsOf.set(track.album, (songsOf.get(track.album) ?? new Set()).add(track.song));
  }

  const cards = albums.flatMap(({ album: row }) => {
    const ref = refs.get(row.id);
    if (ref === undefined || row.title === null) return [];
    const card = new AlbumCard({
      ref: AlbumRef.make(ref),
      title: row.title,
      artist: row.artistName,
      artistRef: catalogArtistRef(root),
      releaseDate: row.year === null ? null : String(row.year),
      ...cardTypes(row.type),
      explicit: false,
      trackCount: songsOf.get(row.id)?.size ?? null,
      artworkUrl: row.artworkUrl,
    });
    return [{ id: row.id, card, songs: songsOf.get(row.id) ?? new Set<string>() }];
  });
  // A single is hidden when all its songs are on an album of the artist
  const onAlbums = new Set(
    cards.flatMap((entry) => (entry.card.primaryType === "single" ? [] : [...entry.songs])),
  );
  const shown = cards.filter(
    (entry) =>
      entry.card.primaryType !== "single" ||
      entry.songs.size === 0 ||
      [...entry.songs].some((song) => !onAlbums.has(song)),
  );

  const credits = yield* db
    .selectDistinct({ id: sql<string>`coalesce(${recording.mergedIntoId}, ${recording.id})` })
    .from(songArtist)
    .innerJoin(recording, eq(recording.id, songArtist.recordingId))
    .leftJoin(credited, eq(credited.id, songArtist.artistId))
    .where(sql`coalesce(${credited.mergedIntoId}, ${songArtist.artistId}) = ${root}`);
  const songs = (yield* songEntries(credits.map((row) => row.id))).flatMap((entry) =>
    entry.source === null
      ? []
      : [new PageTrack({ source: entry.source, disc: null, number: null, playable: true })],
  );

  return {
    name: named?.name ?? cachedName ?? null,
    albums: shown.map((entry) => ({ id: entry.id, card: entry.card })),
    songs: [...songs, ...cachedSongs],
  };
});

// Releases of two providers are one card when they are editions of one album, else when they have
// the same title and no other stated type or dates at most 7 days apart. Upload providers state
// types that other providers do not share. The title is without edition words, guests and an
// `EP` or `Single` suffix, so that `Say It (feat. Tove Lo) [Remixes]` is `Say It (Remixes)`.
const releaseTitle = (card: AlbumCard) =>
  simplifyText(withoutGuests(splitEdition(card.title).base)).replace(/\s(?:ep|single)$/u, "");
const releaseType = (card: AlbumCard) =>
  card.primaryType === null ? null : `${card.primaryType}|${card.secondaryTypes.join()}`;
const sameRelease = (a: AlbumCard, b: AlbumCard) => {
  if (releaseTitle(a) !== releaseTitle(b)) return false;
  const [typeA, typeB] = [releaseType(a), releaseType(b)];
  if (typeA === null || typeB === null || typeA === typeB) return true;
  const day = /^\d{4}-\d{2}-\d{2}$/u;
  if (!day.test(a.releaseDate ?? "") || !day.test(b.releaseDate ?? "")) return false;
  return Math.abs(Date.parse(a.releaseDate!) - Date.parse(b.releaseDate!)) <= 7 * 86_400_000;
};

// Fetching while one page fetches, else fresh when one page is fresh, else the first failure
const combinedState = (states: ReadonlyArray<PageState>) =>
  states.find((state) => state.status === "fetching") ??
  states.find((state) => state.status === "fresh") ??
  states[0] ??
  new PageState({ status: "fresh", fetchedAt: null, reason: null });

const mixedArtistPage = Effect.fn(function* (
  pageRef: ArtistRef,
  root: string,
  catalog: Effect.Success<ReturnType<typeof catalogArtist>>,
  pages: ReadonlyArray<PageInput<ProviderArtist>>,
  uploads: ReadonlySet<string>,
  priority: (provider: string) => number,
) {
  const db = yield* Database;

  // The album of each provider release that has an edition
  const releases = pages.flatMap((page) =>
    (page.data?.releases ?? []).map((release) => ({ page, release })),
  );
  const appearances = pages.flatMap((page) =>
    (page.data?.appearsOn ?? []).map((release) => ({ page, release })),
  );
  const editionIds = new Map(
    yield* Effect.forEach([...releases, ...appearances], ({ page, release }) =>
      uuidV5(`${page.provider}:edition:${release.externalId}`).pipe(
        Effect.map((id) => [`${page.provider}:${release.externalId}`, id] as const),
      ),
    ),
  );
  const albumOfEdition = new Map(
    editionIds.size === 0
      ? []
      : (yield* db
          .select({
            id: edition.id,
            album: sql<string>`coalesce(${album.mergedIntoId}, ${album.id})`,
          })
          .from(edition)
          .innerJoin(album, eq(album.id, edition.albumId))
          .where(inArray(edition.id, [...editionIds.values()]))).map((row) => [row.id, row.album]),
  );

  // Catalog albums first, then the releases of each provider in priority order
  const cards = new Map<string, AlbumCard>();
  const sameTitle = (card: AlbumCard) =>
    [...cards].find(([, other]) => sameRelease(card, other))?.[0];
  for (const { id, card } of catalog.albums) cards.set(`album:${id}`, card);
  const keyOf = (provider: string, card: AlbumCard, externalId: string) => {
    const albumId = albumOfEdition.get(editionIds.get(`${provider}:${externalId}`) ?? "");
    if (albumId !== undefined && cards.has(`album:${albumId}`)) return `album:${albumId}`;
    return sameTitle(card) ?? `${provider}:${externalId}`;
  };
  for (const { page, release } of releases) {
    const card = releaseCard(page.provider, release);
    const key = keyOf(page.provider, card, release.externalId);
    if (!cards.has(key)) cards.set(key, card);
  }
  const appearsOn = new Map<string, AlbumCard>();
  for (const { page, release } of appearances) {
    const card = releaseCard(page.provider, release);
    const key = keyOf(page.provider, card, release.externalId);
    if (!cards.has(key) && !appearsOn.has(key)) appearsOn.set(key, card);
  }

  // One row per song. The top tracks come from the first page that has them.
  const top = pages.find((page) => (page.data?.topTracks.length ?? 0) > 0);
  const rows = [
    ...(top === undefined
      ? []
      : (yield* providerTracks(top.provider, top.providerName, top.data?.topTracks ?? [])).map(
          (track) => ({ track, top: true }),
        )),
    ...(yield* Effect.forEach(pages, (page) =>
      providerTracks(page.provider, page.providerName, page.data?.tracks ?? []),
    )).flatMap((list) => list.map((track) => ({ track, top: false }))),
    ...catalog.songs.map((track) => ({ track, top: false })),
  ];
  const bound = [...new Set(rows.flatMap((row) => row.track.source.recordingId ?? []))];
  const roots = new Map(
    bound.length === 0
      ? []
      : (yield* db
          .select({ id: recording.id, root: recording.mergedIntoId })
          .from(recording)
          .where(inArray(recording.id, bound))).map((row) => [row.id, row.root ?? row.id]),
  );
  const songOf = (track: PageTrack) => {
    const id = track.source.recordingId;
    return id === null ? null : (roots.get(id) ?? id);
  };
  const asNamed = (track: PageTrack) => ({
    summary: track.source,
    upload: uploads.has(track.source.provider),
  });
  // A row joins the group of the same recording, else the group whose rows all have its name
  const groups: Array<{ top: boolean; tracks: Array<PageTrack> }> = [];
  for (const row of rows) {
    const song = songOf(row.track);
    const group =
      groups.find((members) =>
        members.tracks.some((member) => song !== null && songOf(member) === song),
      ) ??
      groups.find((members) =>
        members.tracks.every((member) => sameNamedSong(asNamed(member), asNamed(row.track))),
      );
    if (group === undefined) groups.push({ top: row.top, tracks: [row.track] });
    else group.tracks.push(row.track);
  }
  const byProvider = compareSources(yield* providerOrder);
  // The owner's provider order, then the provider with the higher metadata priority
  const compare = (a: PageTrack, b: PageTrack) =>
    byProvider(
      { provider: a.source.provider, lossless: false },
      { provider: b.source.provider, lossless: false },
    ) || priority(b.source.provider) - priority(a.source.provider);
  const best = (tracks: ReadonlyArray<PageTrack>) =>
    tracks.reduce((current, next) => (compare(next, current) < 0 ? next : current));
  const shownTop = groups.flatMap((group) => (group.top ? [best(group.tracks)] : []));
  const shownTracks = groups.flatMap((group) => (group.top ? [] : [best(group.tracks)]));

  const similar = [
    ...new Map(
      pages
        .flatMap((page) =>
          (page.data?.similar ?? []).map(
            (other) =>
              new ArtistCard({
                ref: providerArtistRef(page.provider, other.externalId),
                name: other.name,
                artworkUrl: other.artworkUrl,
              }),
          ),
        )
        .map((card) => [normV1(card.name), card]),
    ).values(),
  ];

  const discography = [...cards.values()];
  const named = pages.find((page) => page.data !== null)?.data?.artist;
  return new ArtistPage({
    ref: pageRef,
    providerName: null,
    name: catalog.name ?? named?.name ?? null,
    artworkUrl:
      pages.find((page) => page.data?.artist.artworkUrl != null)?.data?.artist.artworkUrl ?? null,
    sections: [
      ...(shownTop.length === 0
        ? []
        : [new TrackSection({ kind: "top_tracks", tracks: shownTop })]),
      ...releaseSections(discography),
      ...(appearsOn.size === 0
        ? []
        : [
            new AlbumSection({
              kind: "appears_on",
              albums: [...appearsOn.values()].toSorted(newestFirst),
            }),
          ]),
      ...(shownTracks.length === 0
        ? []
        : [new TrackSection({ kind: "tracks", tracks: shownTracks })]),
      ...(similar.length === 0
        ? []
        : [new ArtistSection({ kind: "similar_artists", artists: similar })]),
    ],
    state: combinedState(pages.map((page) => page.state)),
  });
});

// All tracks of the album: the tracks of the original edition, then the tracks of the other
// editions that are not on it, marked with their edition words
const albumTracks = Effect.fn(function* (
  page: PageInput<ProviderAlbum>,
  externalId: string,
  data: ProviderAlbum,
) {
  const db = yield* Database;
  const plugins = yield* Providers;
  const own = yield* providerTracks(page.provider, page.providerName, data.tracks);
  const editions = yield* albumEditions(page.provider, externalId);
  if (editions.length === 0) return own;

  const cached = Effect.fn(function* (originRef: string) {
    const parts = Option.getOrNull(providerRefParts(originRef));
    if (parts === null) return [];
    const [row] = yield* db
      .select({ data: providerPage.data })
      .from(providerPage)
      .where(
        and(
          eq(providerPage.provider, parts.provider),
          eq(providerPage.kind, "album"),
          eq(providerPage.externalId, parts.externalId),
        ),
      );
    const album =
      row === undefined ? Option.none() : Schema.decodeUnknownOption(ProviderAlbum)(row.data);
    if (Option.isNone(album)) return [];
    const name = plugins.get(parts.provider)?.name ?? parts.provider;
    return yield* providerTracks(parts.provider, name, album.value.tracks);
  });
  const found = yield* Effect.forEach(editions, (edition) =>
    Effect.gen(function* () {
      const tracks = edition.hasPage ? own : yield* firstNonEmpty(edition.albums.map(cached));
      return { words: edition.words, tracks };
    }),
  );
  // The first edition with tracks is the base, also when the original has no cached page
  const lists = found
    .filter((edition) => edition.tracks.length > 0)
    .map((edition, index) =>
      edition.tracks.map((track) =>
        index === 0 ? track : new PageTrack({ ...track, edition: edition.words }),
      ),
    );

  const ids = [...new Set(lists.flat().flatMap((track) => track.source.recordingId ?? []))];
  const roots = new Map(
    (yield* db
      .select({ id: recording.id, root: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, ids))).map((row) => [row.id, row.root ?? row.id]),
  );
  const seen = new Set<string>();
  return lists.flat().filter((track) => {
    const bound = track.source.recordingId;
    const song = bound === null ? track.source.id : (roots.get(bound) ?? bound);
    if (seen.has(song)) return false;
    seen.add(song);
    return true;
  });
});

const firstNonEmpty = Effect.fn(function* <A, E, R>(
  lists: ReadonlyArray<Effect.Effect<ReadonlyArray<A>, E, R>>,
) {
  for (const list of lists) {
    const found = yield* list;
    if (found.length > 0) return found;
  }
  return [];
});

/** Before the first fetch, a provider album page shows the tracks that the user saved */
export const albumPage = (ref: AlbumRef) =>
  Option.match(providerRefParts(ref), {
    onNone: () => Stream.fromEffect(localAlbumPage(ref).pipe(orDieOnDatabaseError("albumPage"))),
    onSome: (parts) =>
      providerPageStream("album", parts, ProviderAlbum, {
        fetch: (plugin) => plugin.album,
        tracks: (data) => data.tracks,
        facts: (data) =>
          assertEdition(parts.provider, data).pipe(orDieOnDatabaseError("assertEdition")),
        build: (page) =>
          Effect.gen(function* () {
            const saved = page.library.filter((item) => item.summary.albumRef === ref);
            if (page.data === null) {
              return new AlbumPage({
                ref,
                providerName: page.providerName,
                album:
                  (yield* libraryAlbumCards(saved).pipe(orDieOnDatabaseError("albumPage")))[0] ??
                  null,
                tracks: saved.map(
                  (item) =>
                    new PageTrack({
                      source: item.summary,
                      disc: null,
                      number: null,
                      playable: true,
                    }),
                ),
                state: page.state,
              });
            }

            return new AlbumPage({
              ref,
              providerName: page.providerName,
              album: releaseCard(page.provider, page.data.release),
              tracks: yield* albumTracks(page, parts.externalId, page.data).pipe(
                orDieOnDatabaseError("albumTracks"),
              ),
              state: page.state,
            });
          }),
      }),
  });
