import { Effect, Schema } from "effect";

import {
  DeviceId,
  PlayContext,
  RecordingId,
  ReplicaId,
  UserId,
  WorkspaceId,
} from "./primitives.ts";

/** A client and a server sync only when they have the same version */
export const syncProtocolVersion = 3;

/**
 * Hybrid logical clock value: `<wall ms, 15 digits>-<counter, 4 base-36 digits>-<replica_id>`.
 * Values sort as strings. The replica ID makes values from different replicas unique.
 */
export const HybridLogicalClock = Schema.String.check(
  Schema.isPattern(/^\d{15}-[0-9a-z]{4}-[0-9a-f-]{36}$/),
).pipe(Schema.brand("HybridLogicalClock"));
export type HybridLogicalClock = typeof HybridLogicalClock.Type;

const Uuid = Schema.String.check(Schema.isUUID());

/** `user:<user_id>` or `collection:<playlist_id>` */
export const SyncScope = Schema.String.check(
  Schema.isPattern(/^(user|collection):[0-9a-f-]{36}$/),
).pipe(Schema.brand("SyncScope"));
export type SyncScope = typeof SyncScope.Type;

export class LibraryItemRow extends Schema.Class<LibraryItemRow>("LibraryItemRow")({
  table: Schema.Literal("library_item"),
  id: Uuid,
  userId: UserId,
  entityType: Schema.Literal("recording"),
  entityId: RecordingId,
  origin: Schema.String,
  addedAt: Schema.Int,
  hlc: HybridLogicalClock,
  deleted: Schema.Boolean,
}) {}

/** The HLC of each field that a later write changed. A field without a key has the row `hlc`. */
export const FieldClocks = Schema.NullOr(Schema.Record(Schema.String, HybridLogicalClock)).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(null)),
);

/**
 * The provider playlist that the server syncs with a playlist. `import`: the server applies the
 * provider's changes and keeps the edits in Dyad.
 */
export class PlaylistLink extends Schema.Class<PlaylistLink>("PlaylistLink")({
  provider: Schema.String,
  remoteId: Schema.NullOr(Schema.String),
  direction: Schema.Literal("import"),
}) {}

export class PlaylistRow extends Schema.Class<PlaylistRow>("PlaylistRow")({
  table: Schema.Literal("playlist"),
  id: Uuid,
  ownerId: UserId,
  name: Schema.String,
  origin: Schema.NullOr(Schema.String),
  link: Schema.NullOr(PlaylistLink).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  createdAt: Schema.Int,
  hlc: HybridLogicalClock,
  fieldHlc: FieldClocks,
  deleted: Schema.Boolean,
}) {}

export class PlaylistEntryRow extends Schema.Class<PlaylistEntryRow>("PlaylistEntryRow")({
  table: Schema.Literal("playlist_entry"),
  id: Uuid,
  playlistId: Uuid,
  recordingId: RecordingId,
  position: Schema.String,
  addedAt: Schema.Int,
  hlc: HybridLogicalClock,
  fieldHlc: FieldClocks,
  deleted: Schema.Boolean,
}) {}

export class PlayEventRow extends Schema.Class<PlayEventRow>("PlayEventRow")({
  table: Schema.Literal("play_event"),
  /** UUIDv7 */
  id: Uuid,
  userId: UserId,
  deviceId: DeviceId,
  sourceId: Uuid,
  recordingId: Schema.NullOr(RecordingId),
  /** Server time */
  startedAt: Schema.Int,
  playedMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  completed: Schema.Boolean,
  context: PlayContext,
  scrobbled: Schema.Boolean,
}) {}

/** One row of a synced table, without the server's `change_seq` */
export const SyncRow = Schema.Union([LibraryItemRow, PlaylistRow, PlaylistEntryRow, PlayEventRow]);
export type SyncRow = typeof SyncRow.Type;

export const SyncTable = Schema.Literals([
  "library_item",
  "playlist",
  "playlist_entry",
  "play_event",
]);
export type SyncTable = typeof SyncTable.Type;

export class RecordingRow extends Schema.Class<RecordingRow>("RecordingRow")({
  id: RecordingId,
  title: Schema.NullOr(Schema.String),
  artistCreditId: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
  disambiguation: Schema.NullOr(Schema.String),
  artistName: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
  explicit: Schema.NullOr(Schema.Boolean),
  mergedIntoId: Schema.NullOr(RecordingId),
  origin: Schema.Literals(["musicbrainz", "isrc", "provider", "local", "admin"]),
  status: Schema.Literals(["active", "merged", "hidden"]),
  policyVersion: Schema.Int,
  revision: Schema.Int,
}) {}

export class SourceRow extends Schema.Class<SourceRow>("SourceRow")({
  id: Uuid,
  provider: Schema.String,
  externalId: Schema.String,
  kind: Schema.Literals(["stream", "live", "file", "purchase"]),
  recordingId: Schema.NullOr(RecordingId),
  trackId: Schema.NullOr(Schema.String),
  rawTitle: Schema.NullOr(Schema.String),
  rawArtist: Schema.NullOr(Schema.String),
  rawAlbum: Schema.NullOr(Schema.String),
  rawDurationMs: Schema.NullOr(Schema.Finite),
  availability: Schema.Literals(["available", "unavailable", "region_locked", "removed"]),
  checkedAt: Schema.NullOr(Schema.Int),
  policyVersion: Schema.Int,
  revision: Schema.Int,
}) {}

export class SourceVariantRow extends Schema.Class<SourceVariantRow>("SourceVariantRow")({
  id: Schema.String,
  sourceId: Uuid,
  codec: Schema.String,
  container: Schema.String,
  sampleRate: Schema.NullOr(Schema.Int),
  bitDepth: Schema.NullOr(Schema.Int),
  channels: Schema.NullOr(Schema.Int),
  bitrate: Schema.NullOr(Schema.Int),
  lossless: Schema.Boolean,
  encrypted: Schema.Boolean,
}) {}

export class SourceSegmentRow extends Schema.Class<SourceSegmentRow>("SourceSegmentRow")({
  sourceId: Uuid,
  position: Schema.Int,
  recordingId: Schema.NullOr(RecordingId),
  rawArtist: Schema.NullOr(Schema.String),
  rawTitle: Schema.NullOr(Schema.String),
  startMs: Schema.NullOr(Schema.Int),
  endMs: Schema.NullOr(Schema.Int),
}) {}

/** The library keys of a local file on the server, for the page refs of its source */
export class SourceKeyRow extends Schema.Class<SourceKeyRow>("SourceKeyRow")({
  sourceId: Uuid,
  albumArtistKey: Schema.NullOr(Schema.String),
  artistKey: Schema.NullOr(Schema.String),
  albumKey: Schema.NullOr(Schema.String),
}) {}

export class LibraryRemoteTrackRow extends Schema.Class<LibraryRemoteTrackRow>(
  "LibraryRemoteTrackRow",
)({
  userId: UserId,
  provider: Schema.String,
  recordingId: RecordingId,
  remoteId: Schema.String,
  catalogId: Schema.NullOr(Schema.String),
  sourceId: Schema.NullOr(Uuid),
  rawTitle: Schema.String,
  rawArtist: Schema.NullOr(Schema.String),
  rawAlbum: Schema.NullOr(Schema.String),
  rawDurationMs: Schema.NullOr(Schema.Finite),
  seenAt: Schema.Int,
}) {}

/**
 * A root recording, the recordings merged into it, their sources, variants and segments, and the
 * remote tracks of the requesting user. A client replaces its rows of the group with these.
 */
export class CatalogGroup extends Schema.Class<CatalogGroup>("CatalogGroup")({
  rootId: RecordingId,
  revision: Schema.Int,
  recordings: Schema.Array(RecordingRow),
  sources: Schema.Array(SourceRow),
  variants: Schema.Array(SourceVariantRow),
  sourceKeys: Schema.Array(SourceKeyRow),
  remoteTracks: Schema.Array(LibraryRemoteTrackRow),
  segments: Schema.Array(SourceSegmentRow).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

export class CatalogCursor extends Schema.Class<CatalogCursor>("CatalogCursor")({
  revision: Schema.Int,
  rootId: RecordingId,
}) {}

export class CatalogPage extends Schema.Class<CatalogPage>("CatalogPage")({
  groups: Schema.Array(CatalogGroup),
  /** Requested recordings that have no row. The client keeps each as its own root. */
  missing: Schema.Array(RecordingId),
  /** The provider library data of `missing`, for example a song that only the user's library has */
  missingRemoteTracks: Schema.Array(LibraryRemoteTrackRow).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  cursor: Schema.NullOr(CatalogCursor),
}) {}

/** The client has applied the rows of `scope` up to this position */
export class ScopeCursor extends Schema.Class<ScopeCursor>("ScopeCursor")({
  scope: SyncScope,
  changeSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * `<table>:<id>` of the last applied row when a page ended inside the rows of `changeSeq`. Only
   * the first load of a scope splits the rows of one `changeSeq`.
   */
  rowKey: Schema.NullOr(Schema.String),
}) {}

export class SyncPullRequest extends Schema.Class<SyncPullRequest>("SyncPullRequest")({
  replicaId: ReplicaId,
  protocolVersion: Schema.Int,
  /** The last epoch that the client saw. A different epoch resets all cursors. */
  epoch: Schema.NullOr(Uuid),
  scopes: Schema.Array(ScopeCursor).check(Schema.isMaxLength(1000)),
  catalogCursor: Schema.NullOr(CatalogCursor),
  /** Bound recordings that the client refers to and does not have */
  wantRecordings: Schema.Array(RecordingId).check(Schema.isMaxLength(1000)),
}) {}

export class SyncPullResponse extends Schema.Class<SyncPullResponse>("SyncPullResponse")({
  workspaceId: WorkspaceId,
  serverReplicaId: ReplicaId,
  /** Changes when the server database is restored from a backup */
  epoch: Uuid,
  serverTime: Schema.Finite,
  /** The client deletes the local rows of scopes that are not in this list */
  readableScopes: Schema.Array(SyncScope),
  /** Per scope in `change_seq` order */
  rows: Schema.Array(SyncRow),
  cursors: Schema.Array(ScopeCursor),
  catalog: CatalogPage,
  more: Schema.Boolean,
}) {}

export class PlayEventAppend extends Schema.Class<PlayEventAppend>("PlayEventAppend")({
  kind: Schema.Literal("play_event.append"),
  schemaVersion: Schema.Literal(1),
  row: PlayEventRow,
}) {}

export const PlaylistName = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200));

// `fractional-indexing` keys. A malformed key would break the inserts of other replicas.
const Position = Schema.String.check(Schema.isPattern(/^[A-Za-z][0-9A-Za-z]{0,199}$/));

/** A new playlist of the user, without entries */
export class PlaylistCreate extends Schema.Class<PlaylistCreate>("PlaylistCreate")({
  kind: Schema.Literal("playlist.create"),
  schemaVersion: Schema.Literal(1),
  row: PlaylistRow.check(
    Schema.makeFilter((row) =>
      Schema.is(PlaylistName)(row.name) &&
      row.origin === null &&
      row.link === null &&
      !row.deleted &&
      !row.fieldHlc
        ? undefined
        : "Expected a new named playlist without an origin",
    ),
  ),
}) {}

/** Sets the given fields with `hlc` */
export class PlaylistPatch extends Schema.Class<PlaylistPatch>("PlaylistPatch")({
  kind: Schema.Literal("playlist.patch"),
  schemaVersion: Schema.Literal(1),
  id: Uuid,
  hlc: HybridLogicalClock,
  name: Schema.optionalKey(PlaylistName),
  /** Unlinks the provider playlist. The playlist stays. */
  link: Schema.optionalKey(Schema.Null),
  deleted: Schema.optionalKey(Schema.Literal(true)),
}) {}

export class PlaylistEntryAdd extends Schema.Class<PlaylistEntryAdd>("PlaylistEntryAdd")({
  kind: Schema.Literal("playlist_entry.add"),
  schemaVersion: Schema.Literal(1),
  row: PlaylistEntryRow.check(
    Schema.makeFilter((row) =>
      Schema.is(Position)(row.position) && !row.deleted && !row.fieldHlc
        ? undefined
        : "Expected a new entry",
    ),
  ),
  /** The source that the user added. The server adds a search result to the catalog. */
  sourceId: Schema.NullOr(Uuid),
}) {}

/** Sets the given fields with `hlc` */
export class PlaylistEntryPatch extends Schema.Class<PlaylistEntryPatch>("PlaylistEntryPatch")({
  kind: Schema.Literal("playlist_entry.patch"),
  schemaVersion: Schema.Literal(1),
  id: Uuid,
  hlc: HybridLogicalClock,
  position: Schema.optionalKey(Position),
  deleted: Schema.optionalKey(Schema.Literal(true)),
}) {}

export const SyncChange = Schema.Union([
  PlayEventAppend,
  PlaylistCreate,
  PlaylistPatch,
  PlaylistEntryAdd,
  PlaylistEntryPatch,
]);
export type SyncChange = typeof SyncChange.Type;

/** One local transaction of a client. The server applies all changes or none. */
export class SyncMutation extends Schema.Class<SyncMutation>("SyncMutation")({
  /** Per client replica, from 1, without gaps */
  id: Schema.Int.check(Schema.isGreaterThan(0)),
  changes: Schema.NonEmptyArray(SyncChange).check(Schema.isMaxLength(1000)),
}) {}

export class SyncPushRequest extends Schema.Class<SyncPushRequest>("SyncPushRequest")({
  replicaId: ReplicaId,
  protocolVersion: Schema.Int,
  mutations: Schema.Array(SyncMutation).check(
    Schema.isMaxLength(500),
    Schema.makeFilter((mutations) =>
      mutations.every((mutation, index) => mutation.id > (mutations[index - 1]?.id ?? 0))
        ? undefined
        : "Expected ascending mutation IDs",
    ),
  ),
}) {}

/** The server row after a rejected or changed mutation. `row: null`: the server has no such row. */
export class SyncTouchedRow extends Schema.Class<SyncTouchedRow>("SyncTouchedRow")({
  table: SyncTable,
  id: Uuid,
  row: Schema.NullOr(SyncRow),
}) {}

/**
 * `rejected`: the server changed nothing. `restamped`: the server replaced an HLC that was too far
 * ahead. The client replaces the touched rows and applies its queued mutations to them again.
 */
export class SyncMutationResult extends Schema.Class<SyncMutationResult>("SyncMutationResult")({
  id: Schema.Int,
  outcome: Schema.Literals(["rejected", "restamped"]),
  /** `not_found`: the row or its playlist does not exist or is deleted */
  reason: Schema.NullOr(Schema.Literals(["forbidden", "not_found"])),
  rows: Schema.Array(SyncTouchedRow),
}) {}

export class SyncPushResponse extends Schema.Class<SyncPushResponse>("SyncPushResponse")({
  /** The client deletes its queued mutations up to this ID */
  lastMutationId: Schema.Int,
  results: Schema.Array(SyncMutationResult),
}) {}

/** Something changed on the server. The client pulls. */
export class SyncHint extends Schema.Class<SyncHint>("SyncHint")({}) {}

/** The client and the server have different sync protocol versions */
export class UpgradeRequired extends Schema.TaggedError<UpgradeRequired>()("UpgradeRequired", {
  serverProtocolVersion: Schema.Int,
}) {}

/** Another device uses this replica ID. The client makes a new replica. */
export class ReplicaMismatch extends Schema.TaggedError<ReplicaMismatch>()("ReplicaMismatch", {}) {}
