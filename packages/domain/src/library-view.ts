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
import type { SourceSummary } from "./index.ts";

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

const accountPrefix = "account:";

/** The origin of library items and playlists from the user's linked account */
export const accountOrigin = (provider: string) => `${accountPrefix}${provider}`;

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
}) => {
  const recordings = new Map(rows.recordings.map((row) => [row.id, row]));
  const rootOf = (id: string) => recordings.get(id)?.mergedIntoId ?? id;

  // Local files first, then lossless sources
  const sourcesByRoot = new Map<string, Array<(typeof rows.sources)[number]>>();
  const ranked = rows.sources.toSorted(
    (a, b) =>
      Number(b.summary.provider === "local") - Number(a.summary.provider === "local") ||
      Number(b.lossless) - Number(a.lossless),
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
      items: ReadonlyArray<{ readonly entityId: string; readonly addedAt: number }>,
    ) => {
      const addedAtByRoot = new Map<string, number>();
      for (const item of items) {
        const root = rootOf(item.entityId);
        addedAtByRoot.set(root, Math.min(addedAtByRoot.get(root) ?? item.addedAt, item.addedAt));
      }

      return [...addedAtByRoot]
        .map(([root, addedAt]) => new LibraryEntry({ ...describe(root), addedAt }))
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
