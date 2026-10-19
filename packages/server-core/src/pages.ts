import { libraryItem, localFile, providerItem, providerPage, source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  AlbumCard,
  AlbumPage,
  AlbumSection,
  ArtistCard,
  ArtistPage,
  ArtistRef,
  ArtistSection,
  CurrentPrincipal,
  PageNotFound,
  PageState,
  PageTrack,
  SourceSummary,
  TrackSection,
} from "@dyad/domain";
import type { AlbumRef, UserId } from "@dyad/domain";
import { ProviderAlbum, ProviderArtist, ProviderSource } from "@dyad/plugin";
import type {
  Credentials,
  Provider,
  ProviderError,
  ProviderRelease,
  ProviderTrack,
} from "@dyad/plugin";
import { and, eq, inArray, isNotNull, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Clock, Data, Effect, Option, Schema, Stream } from "effect";

import { artistPageRef } from "./artists.ts";
import { albumTypeOf, editionBase, tagReleaseDate, tagReleaseTypes } from "./editions.ts";
import { albumArtistOf } from "./library.ts";
import { normV1, normalizeArtist } from "./normalize.ts";
import { cacheProviderSources, cachedSummary, toCachedSource } from "./provider-cache.ts";
import { Providers, linkedProviders, usableProviders } from "./providers.ts";
import {
  libraryAlbumKeys,
  libraryArtistKey,
  libraryArtistRef,
  providerAlbumRef,
  providerArtistRef,
  providerRefParts,
} from "./refs.ts";
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

class LibrarySource extends Data.Class<{
  readonly summary: SourceSummary;
  readonly source: ProviderSource;
}> {}

// The provider sources that the user saved in a provider library. Each source of a saved item binds
// to the item's recording, so other sources of a merged recording are not part of it.
const librarySources = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* linkedProviders(userId);

    const rows = yield* db
      .select({
        sourceId: providerItem.sourceId,
        provider: providerItem.provider,
        data: providerItem.data,
      })
      .from(libraryItem)
      .innerJoin(source, eq(source.recordingId, libraryItem.entityId))
      .innerJoin(providerItem, eq(providerItem.sourceId, source.id))
      .where(
        and(
          eq(libraryItem.userId, userId),
          eq(libraryItem.deleted, false),
          inArray(providerItem.provider, [...providers.keys()]),
        ),
      )
      .groupBy(source.id);

    return yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const decoded = yield* Schema.decodeUnknownEffect(ProviderSource)(row.data).pipe(
          Effect.orDie,
        );
        const item = yield* toCachedSource(row.provider, decoded);
        const name = providers.get(row.provider)?.name ?? row.provider;
        return new LibrarySource({ summary: cachedSummary(item, name), source: decoded });
      }),
    );
  });

const libraryArtistCards = (sources: ReadonlyArray<LibrarySource>) =>
  [...groupBy(sources, (item) => item.summary.artistRef)].map(
    ([ref, group]) =>
      new ArtistCard({
        ref,
        name:
          mostCommon(group.map((item) => (item.source.artists[0] ?? item.source.uploader)?.name)) ??
          "",
        artworkUrl: null,
      }),
  );

/**
 * One card for all editions of an album: the same artist and the same name without edition
 * suffixes. It opens the edition with the most saved tracks, else the original edition. The card
 * counts the given tracks, because the provider's album is not known without a fetch.
 */
export const libraryAlbumCards = (sources: ReadonlyArray<Pick<LibrarySource, "summary">>) => {
  const editions = [...groupBy(sources, (item) => item.summary.albumRef)].map(([ref, group]) => {
    const artistRef = mostCommon(group.map((item) => item.summary.artistRef ?? undefined));
    return new AlbumCard({
      ref,
      // A release without an album name is a single, for example on Bandcamp
      title:
        mostCommon(group.map((item) => item.summary.album ?? undefined)) ??
        mostCommon(group.map((item) => item.summary.title ?? undefined)) ??
        "",
      artist: mostCommon(group.map((item) => item.summary.artist ?? undefined)),
      artistRef: artistRef === null ? null : ArtistRef.make(artistRef),
      releaseDate: null,
      primaryType: null,
      secondaryTypes: [],
      explicit: group.some((item) => item.summary.explicit),
      trackCount: group.length,
      artworkUrl:
        group.find((item) => item.summary.artworkUrl !== null)?.summary.artworkUrl ?? null,
    });
  });

  const albums = groupBy(
    editions,
    (card) => `${normalizeArtist(card.artist ?? "")}\n${normV1(editionBase(card.title))}`,
  );
  return [...albums.values()].flatMap((group) => {
    const [shown] = group.toSorted(
      (a, b) =>
        (b.trackCount ?? 0) - (a.trackCount ?? 0) ||
        Number(editionBase(a.title) !== a.title) - Number(editionBase(b.title) !== b.title) ||
        a.ref.localeCompare(b.ref),
    );
    if (shown === undefined) return [];
    const card = new AlbumCard({
      ...shown,
      title: editionBase(shown.title),
      explicit: group.some((edition) => edition.explicit),
      trackCount: group.reduce((total, edition) => total + (edition.trackCount ?? 0), 0),
      artworkUrl:
        shown.artworkUrl ??
        group.find((edition) => edition.artworkUrl !== null)?.artworkUrl ??
        null,
    });
    return [card];
  });
};

/** The album artists of the files on this replica and the artists of the provider library */
export const listLibraryArtists = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const files = yield* libraryFiles(isNotNull(localFile.albumArtistKey));
  const saved = yield* librarySources(principal.userId);

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
  const principal = yield* CurrentPrincipal;
  const files = yield* libraryFiles(
    and(isNotNull(localFile.albumArtistKey), isNotNull(localFile.albumKey)),
  );
  const saved = yield* librarySources(principal.userId);

  return [...albumCards(files), ...libraryAlbumCards(saved)].toSorted(
    (a, b) => (a.artist ?? "").localeCompare(b.artist ?? "") || a.title.localeCompare(b.title),
  );
});

// The albums of the album artist, the albums where the artist has tracks, and the artist's tracks
// without an album
const localArtistPage = (ref: ArtistRef) =>
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

// The tracks of the album in disc and track order
const localAlbumPage = (ref: AlbumRef) =>
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

// Like search results, a track of a page enters the shared catalog only when it is played
const pageLifetimeMs = 24 * 60 * 60 * 1000;

// Apple pages need a request for each view with more than 10 releases
const fetchTimeout = "20 seconds";

export const providerTracks = (
  provider: string,
  providerName: string,
  tracks: ReadonlyArray<ProviderTrack>,
) =>
  Effect.forEach(tracks, (track) =>
    toCachedSource(provider, track.source).pipe(
      Effect.map(
        (item) =>
          new PageTrack({
            source: cachedSummary(item, providerName),
            disc: track.disc,
            number: track.number,
            playable: track.streamable,
          }),
      ),
    ),
  );

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
    readonly build: (page: PageInput<A>) => Effect.Effect<Page, never, R>;
  },
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const db = yield* Database;
      const principal = yield* CurrentPrincipal;
      const plugins = yield* Providers;
      const { provider, externalId } = parts;
      const plugin = plugins.get(provider);
      const providerName = plugin?.name ?? provider;
      const library = yield* librarySources(principal.userId);

      const emit = (data: A | null, state: PageState) =>
        options.build(new PageInput({ provider, providerName, data, library, state }));
      const failed = (reason: string) =>
        Stream.fromEffect(emit(null, new PageState({ status: "failed", fetchedAt: null, reason })));

      if (plugin === undefined) return failed("No plugin gives this page");
      // Cached pages too, because the tracks of a page play only with the user's credentials
      const usable = (yield* usableProviders(principal.userId)).get(provider);
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
      const refresh = Effect.gen(function* () {
        // Before the tracks, so that every track of the page is at least as new as the page
        const fetchedAt = yield* Clock.currentTimeMillis;
        const data = yield* fetch(externalId, usable.credentials).pipe(
          Effect.timeout(fetchTimeout),
        );
        yield* cacheProviderSources(
          provider,
          options.tracks(data).map((track) => track.source),
        );
        const values = {
          provider,
          kind,
          externalId,
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
        return yield* emit(data, new PageState({ status: "fresh", fetchedAt, reason: null }));
      }).pipe(
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

/** A library ref gives one emission. A catalog ref shows the page of one provider artist. */
export const artistPage = (ref: ArtistRef) =>
  Stream.unwrap(
    artistPageRef(ref).pipe(Effect.map(refArtistPage), orDieOnDatabaseError("artistPage")),
  );

const refArtistPage = (ref: ArtistRef) =>
  Option.match(providerRefParts(ref), {
    onNone: () => Stream.fromEffect(localArtistPage(ref).pipe(orDieOnDatabaseError("artistPage"))),
    onSome: (parts) =>
      providerPageStream("artist", parts, ProviderArtist, {
        fetch: (plugin) => plugin.artist,
        tracks: (data) => [...data.topTracks, ...data.tracks],
        build: (page) =>
          Effect.gen(function* () {
            const data = page.data;
            const saved = page.library.filter((item) => item.summary.artistRef === ref);
            const inLibrary = libraryAlbumCards(saved).toSorted(newestFirst);
            const topTracks = yield* providerTracks(
              page.provider,
              page.providerName,
              data?.topTracks ?? [],
            );
            const tracks = yield* providerTracks(
              page.provider,
              page.providerName,
              data?.tracks ?? [],
            );
            const releases = (data?.releases ?? []).map((release) =>
              releaseCard(page.provider, release),
            );
            const appearsOn = (data?.appearsOn ?? [])
              .map((release) => releaseCard(page.provider, release))
              .toSorted(newestFirst);
            const similar = (data?.similar ?? []).map(
              (artist) =>
                new ArtistCard({
                  ref: providerArtistRef(page.provider, artist.externalId),
                  name: artist.name,
                  artworkUrl: artist.artworkUrl,
                }),
            );

            return new ArtistPage({
              ref,
              providerName: page.providerName,
              name: data?.artist.name ?? libraryArtistCards(saved)[0]?.name ?? null,
              artworkUrl: data?.artist.artworkUrl ?? null,
              sections: [
                ...(topTracks.length === 0
                  ? []
                  : [new TrackSection({ kind: "top_tracks", tracks: topTracks })]),
                ...(inLibrary.length === 0
                  ? []
                  : [new AlbumSection({ kind: "in_library", albums: inLibrary })]),
                ...releaseSections(releases),
                ...(appearsOn.length === 0
                  ? []
                  : [new AlbumSection({ kind: "appears_on", albums: appearsOn })]),
                ...(tracks.length === 0 ? [] : [new TrackSection({ kind: "tracks", tracks })]),
                ...(similar.length === 0
                  ? []
                  : [new ArtistSection({ kind: "similar_artists", artists: similar })]),
              ],
              state: page.state,
            });
          }),
      }),
  });

/** Before the first fetch, a provider album page shows the tracks that the user saved */
export const albumPage = (ref: AlbumRef) =>
  Option.match(providerRefParts(ref), {
    onNone: () => Stream.fromEffect(localAlbumPage(ref).pipe(orDieOnDatabaseError("albumPage"))),
    onSome: (parts) =>
      providerPageStream("album", parts, ProviderAlbum, {
        fetch: (plugin) => plugin.album,
        tracks: (data) => data.tracks,
        build: (page) =>
          Effect.gen(function* () {
            const saved = page.library.filter((item) => item.summary.albumRef === ref);
            if (page.data === null) {
              return new AlbumPage({
                ref,
                providerName: page.providerName,
                album: libraryAlbumCards(saved)[0] ?? null,
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
              tracks: yield* providerTracks(page.provider, page.providerName, page.data.tracks),
              state: page.state,
            });
          }),
      }),
  });
