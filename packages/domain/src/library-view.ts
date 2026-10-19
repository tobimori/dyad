import {
  AlbumRef,
  ArtistRef,
  LibraryEntry,
  PlaylistEntry,
  PlaylistLink,
  PlaylistLinkState,
  PlaylistSummary,
  RecordingId,
} from "./index.ts";
import type { SourceCopy, SourceSummary } from "./index.ts";
import { Option } from "effect";

/** The namespace of refs to the server's library folder. Provider IDs cannot be `library`. */
export const libraryRefPrefix = "library:";

// `encodeURIComponent` keeps a `/` in a key, for example in `ac/dc`, from splitting an album ref
/** `library:<artist key>`, where the key is the `norm_v1` of the name */
export const libraryArtistRef = (artistKey: string) =>
  ArtistRef.make(`${libraryRefPrefix}${encodeURIComponent(artistKey)}`);

/** `library:<album artist key>/<album key>` */
export const libraryAlbumRef = (albumArtistKey: string, albumKey: string) =>
  AlbumRef.make(
    `${libraryRefPrefix}${encodeURIComponent(albumArtistKey)}/${encodeURIComponent(albumKey)}`,
  );

/** The namespace of refs to canonical catalog entities. Provider IDs cannot be `catalog`. */
export const catalogRefPrefix = "catalog:";

/** `catalog:<artist ID>` of the root of the artist's merge group */
export const catalogArtistRef = (artistId: string) =>
  ArtistRef.make(`${catalogRefPrefix}${artistId}`);

/** The artist ID of a catalog artist ref */
export const catalogArtistId = (ref: string) =>
  ref.startsWith(catalogRefPrefix)
    ? Option.some(ref.slice(catalogRefPrefix.length))
    : Option.none();

const accountPrefix = "account:";

/** The origin of library items and playlists from the user's linked account */
export const accountOrigin = (provider: string) => `${accountPrefix}${provider}`;

/** The origin of the songs that the save of an album added */
export const albumOrigin = (albumId: string) => `album:${albumId}`;

export const playlistSummary = (
  row: {
    readonly id: string;
    readonly name: string;
    readonly link: typeof PlaylistLink.Encoded | null;
    readonly linkState: typeof PlaylistLinkState.Encoded | null;
  },
  entryCount: number,
) =>
  new PlaylistSummary({
    id: row.id,
    name: row.name,
    entryCount,
    link: row.link === null ? null : new PlaylistLink(row.link),
    linkState: row.linkState === null ? null : new PlaylistLinkState(row.linkState),
  });

/**
 * Orders the sources of one recording, best first: the user's provider order, then local files,
 * then lossless sources. Providers that the order leaves out come after the others.
 */
export const compareSources =
  (providerOrder: ReadonlyArray<string>) =>
  (
    a: { readonly provider: string; readonly lossless: boolean },
    b: { readonly provider: string; readonly lossless: boolean },
  ) => {
    const rank = (provider: string) => {
      const index = providerOrder.indexOf(provider);
      return index === -1 ? providerOrder.length : index;
    };
    return (
      rank(a.provider) - rank(b.provider) ||
      Number(b.provider === "local") - Number(a.provider === "local") ||
      Number(b.lossless) - Number(a.lossless)
    );
  };

/** The copies that the user can play first, then `compareSources`, then the higher bitrate */
export const compareCopies = (providerOrder: ReadonlyArray<string>) => {
  const compare = compareSources(providerOrder);
  return (a: SourceCopy, b: SourceCopy) =>
    Number(a.unavailable !== null) - Number(b.unavailable !== null) ||
    compare(
      { provider: a.source.provider, lossless: a.lossless },
      { provider: b.source.provider, lossless: b.lossless },
    ) ||
    (b.bitrate ?? 0) - (a.bitrate ?? 0);
};

/**
 * Builds library and playlist entries from catalog rows, so that the server and client replicas
 * show the same entries. A recording without a row or without `mergedIntoId` is its own root.
 */
export const libraryView = (rows: {
  /** The saved recordings and the other members of their groups */
  readonly recordings: ReadonlyArray<{
    readonly id: string;
    readonly mergedIntoId: string | null;
    readonly title: string | null;
    readonly artistName: string | null;
    readonly album: string | null;
    readonly durationMs: number | null;
    readonly artworkUrl: string | null;
  }>;
  /** The sources of the groups that the user can play */
  readonly sources: ReadonlyArray<{
    readonly recordingId: string | null;
    readonly lossless: boolean;
    readonly summary: SourceSummary;
  }>;
  /** The provider library data of the saved recordings */
  readonly remoteTracks: ReadonlyArray<{
    readonly recordingId: string;
    readonly sourceId: string | null;
    readonly catalogId: string | null;
    readonly rawTitle: string;
    readonly rawArtist: string | null;
    readonly rawAlbum: string | null;
    readonly rawDurationMs: number | null;
  }>;
  /** The user's provider order, best first */
  readonly providerOrder: ReadonlyArray<string>;
}) => {
  const recordings = new Map(rows.recordings.map((row) => [row.id, row]));
  const rootOf = (id: string) => recordings.get(id)?.mergedIntoId ?? id;

  const sourcesByRoot = new Map<string, Array<(typeof rows.sources)[number]>>();
  const compare = compareSources(rows.providerOrder);
  const ranked = rows.sources.toSorted((a, b) =>
    compare(
      { provider: a.summary.provider, lossless: a.lossless },
      { provider: b.summary.provider, lossless: b.lossless },
    ),
  );
  for (const row of ranked) {
    if (row.recordingId === null) continue;

    const root = rootOf(row.recordingId);
    const group = sourcesByRoot.get(root) ?? [];
    group.push(row);
    sourcesByRoot.set(root, group);
  }

  const remoteByRoot = new Map(rows.remoteTracks.map((row) => [rootOf(row.recordingId), row]));

  // Without the provider's library data, the likely reason is a provider that the user did not link
  const unavailableReason = (remote: (typeof rows.remoteTracks)[number] | undefined) => {
    if (remote === undefined || remote.sourceId !== null) return "account_required" as const;
    return remote.catalogId === null ? ("library_only" as const) : ("not_in_catalog" as const);
  };

  // The canonical recording first, then the best source, then the provider's library data
  const describe = (root: string) => {
    const candidates = sourcesByRoot.get(root) ?? [];
    const best = candidates[0]?.summary;
    const remote = remoteByRoot.get(root);
    const fields = recordings.get(root);

    return {
      recordingId: RecordingId.make(root),
      title: fields?.title ?? best?.title ?? remote?.rawTitle ?? null,
      artist: fields?.artistName ?? best?.artist ?? remote?.rawArtist ?? null,
      album: fields?.album ?? best?.album ?? remote?.rawAlbum ?? null,
      durationMs: fields?.durationMs ?? best?.durationMs ?? remote?.rawDurationMs ?? null,
      artworkUrl: fields?.artworkUrl ?? best?.artworkUrl ?? null,
      source: best ?? null,
      sourceCount: candidates.length,
      unavailable: best === undefined ? unavailableReason(remote) : null,
    };
  };

  return {
    /** An item from several origins, or two saved versions of one recording, gives one entry */
    libraryEntries: (
      items: ReadonlyArray<{
        readonly entityId: string;
        readonly addedAt: number;
        readonly favorite?: boolean;
      }>,
    ) => {
      const byRoot = new Map<string, { addedAt: number; favorite: boolean }>();
      for (const item of items) {
        const root = rootOf(item.entityId);
        const known = byRoot.get(root);
        byRoot.set(root, {
          addedAt: Math.min(known?.addedAt ?? item.addedAt, item.addedAt),
          favorite: (known?.favorite ?? false) || item.favorite === true,
        });
      }

      return [...byRoot]
        .map(([root, item]) => new LibraryEntry({ ...describe(root), ...item }))
        .toSorted(
          (a, b) =>
            (a.artist ?? "").localeCompare(b.artist ?? "") ||
            (a.album ?? "").localeCompare(b.album ?? "") ||
            (a.title ?? "").localeCompare(b.title ?? ""),
        );
    },
    /** `twoWayProvider`: the provider of the playlist's `two-way` link */
    playlistEntries: (
      entries: ReadonlyArray<{
        readonly id: string;
        readonly recordingId: string;
        readonly addedAt: number;
      }>,
      twoWayProvider: string | null,
    ) =>
      entries.map((entry) => {
        const root = rootOf(entry.recordingId);
        return new PlaylistEntry({
          ...describe(root),
          addedAt: entry.addedAt,
          entryId: entry.id,
          dyadOnly:
            twoWayProvider !== null &&
            !(sourcesByRoot.get(root) ?? []).some(
              (candidate) => candidate.summary.provider === twoWayProvider,
            ),
        });
      }),
  };
};
