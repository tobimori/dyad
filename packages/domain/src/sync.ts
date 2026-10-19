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
export const syncProtocolVersion = 7;

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

/** What a user can add to the library: a song, an album (provider release) or an artist */
export const LibraryEntityType = Schema.Literals(["recording", "release", "artist"]);
export type LibraryEntityType = typeof LibraryEntityType.Type;

/** `user` for a save in Dyad, `account:<provider>` for an import from a linked account */
export const LibraryOrigin = Schema.String.check(
  Schema.isPattern(/^(user|account:.+)$/),
  Schema.isMaxLength(200),
);

/** One library membership. Each write sets all fields. */
export class LibraryItemRow extends Schema.Class<LibraryItemRow>("LibraryItemRow")({
  table: Schema.Literal("library_item"),
  /** UUIDv5 of `library_item:<user_id>:<entity_type>:<entity_id>:<origin>` */
  id: Uuid,
  userId: UserId,
  entityType: LibraryEntityType,
  /** The bound recording, the provider release or the catalog artist that the user saved */
  entityId: Uuid,
  origin: LibraryOrigin,
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
 * provider's changes and keeps the edits in Dyad. `two-way`: it also sends the edits in Dyad that
 * the provider can make.
 */
export class PlaylistLink extends Schema.Class<PlaylistLink>("PlaylistLink")({
  provider: Schema.String,
  /** `null` until the server creates the provider playlist of a `two-way` link */
  remoteId: Schema.NullOr(Schema.String),
  direction: Schema.Literals(["import", "two-way"]),
}) {}

/** The result of the last write to the provider playlist of a `two-way` link. Only the server sets it. */
export class PlaylistLinkState extends Schema.Class<PlaylistLinkState>("PlaylistLinkState")({
  /** The provider cannot make some edits, for example a removal or a new order */
  differs: Schema.Boolean,
  /** Why the last write failed, for example a missing account */
  error: Schema.NullOr(Schema.String),
}) {}

export class PlaylistRow extends Schema.Class<PlaylistRow>("PlaylistRow")({
  table: Schema.Literal("playlist"),
  id: Uuid,
  ownerId: UserId,
  name: Schema.String,
  origin: Schema.NullOr(Schema.String),
  link: Schema.NullOr(PlaylistLink).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  linkState: Schema.NullOr(PlaylistLinkState).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
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

/** Provider IDs, best first, with `local` for files */
export const ProviderRanking = Schema.Array(Schema.String.check(Schema.isMaxLength(100))).check(
  Schema.isMaxLength(100),
);

/** How the user orders the sources of a recording. Each write sets all fields. */
export class SourcePreferenceRow extends Schema.Class<SourcePreferenceRow>("SourcePreferenceRow")({
  table: Schema.Literal("source_preference"),
  /** UUIDv5 of `source_preference:<user_id>:<scope>` */
  id: Uuid,
  userId: UserId,
  scope: Schema.Literal("global"),
  /** Providers that it leaves out come after the others */
  providerRanking: ProviderRanking,
  hlc: HybridLogicalClock,
}) {}

/** The user loves the entity. One row per user and entity; each write sets all fields. */
export class RatingRow extends Schema.Class<RatingRow>("RatingRow")({
  table: Schema.Literal("rating"),
  /** UUIDv5 of `rating:<user_id>:<entity_type>:<entity_id>` */
  id: Uuid,
  userId: UserId,
  entityType: LibraryEntityType,
  /** As in `LibraryItemRow` */
  entityId: Uuid,
  favorite: Schema.Boolean,
  hlc: HybridLogicalClock,
}) {}

/** One row of a synced table, without the server's `change_seq` */
export const SyncRow = Schema.Union([
  LibraryItemRow,
  PlaylistRow,
  PlaylistEntryRow,
  PlayEventRow,
  SourcePreferenceRow,
  RatingRow,
]);
export type SyncRow = typeof SyncRow.Type;

export const SyncTable = Schema.Literals([
  "library_item",
  "playlist",
  "playlist_entry",
  "play_event",
  "source_preference",
  "rating",
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

/** An artist with an MBID or a provider ID. `mergedIntoId` is the root of its merge group. */
export class ArtistRow extends Schema.Class<ArtistRow>("ArtistRow")({
  id: Schema.String,
  localKey: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  sortName: Schema.NullOr(Schema.String),
  kind: Schema.NullOr(
    Schema.Literals(["person", "group", "orchestra", "choir", "character", "other"]),
  ),
  country: Schema.NullOr(Schema.String),
  disambiguation: Schema.NullOr(Schema.String),
  nameKey: Schema.NullOr(Schema.String),
  mergedIntoId: Schema.NullOr(Schema.String),
  origin: Schema.Literals(["musicbrainz", "isrc", "provider", "local", "admin"]),
  status: Schema.Literals(["active", "merged", "hidden"]),
  policyVersion: Schema.Int,
  revision: Schema.Int,
}) {}

/** One name of a content-addressed credit. `artistId` is null for a name without an artist. */
export class ArtistCreditNameRow extends Schema.Class<ArtistCreditNameRow>("ArtistCreditNameRow")({
  artistCreditId: Schema.String,
  position: Schema.Int,
  artistId: Schema.NullOr(Schema.String),
  creditedAs: Schema.String,
  joinPhrase: Schema.String,
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
  /** The names of the credits of the recordings */
  creditNames: Schema.Array(ArtistCreditNameRow).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** The artists of the credits, and all artists of their merge groups */
  artists: Schema.Array(ArtistRow).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
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

/**
 * A new playlist of the user, without entries. With a `two-way` link, the server creates the
 * provider playlist.
 */
export class PlaylistCreate extends Schema.Class<PlaylistCreate>("PlaylistCreate")({
  kind: Schema.Literal("playlist.create"),
  schemaVersion: Schema.Literal(1),
  row: PlaylistRow.check(
    Schema.makeFilter((row) =>
      Schema.is(PlaylistName)(row.name) &&
      row.origin === null &&
      (row.link === null || (row.link.direction === "two-way" && row.link.remoteId === null)) &&
      row.linkState === null &&
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

/** Replaces the user's source preference */
export class SourcePreferenceSet extends Schema.Class<SourcePreferenceSet>("SourcePreferenceSet")({
  kind: Schema.Literal("source_preference.set"),
  schemaVersion: Schema.Literal(1),
  row: SourcePreferenceRow,
}) {}

/**
 * Writes one library row of the user: a save with origin `user`, or a removal of a row of any
 * origin. A removal of an imported row asks the server to remove it on the provider too.
 */
export class LibraryItemSet extends Schema.Class<LibraryItemSet>("LibraryItemSet")({
  kind: Schema.Literal("library_item.set"),
  schemaVersion: Schema.Literal(1),
  row: LibraryItemRow,
  /** The source of a saved song. The server adds a search result to the catalog. */
  sourceId: Schema.NullOr(Uuid),
  /** The provider ref of a saved album or artist, so that the server can add it to the catalog */
  ref: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
}) {}

/** Replaces the user's rating of an entity */
export class RatingSet extends Schema.Class<RatingSet>("RatingSet")({
  kind: Schema.Literal("rating.set"),
  schemaVersion: Schema.Literal(1),
  row: RatingRow,
}) {}

export const SyncChange = Schema.Union([
  LibraryItemSet,
  RatingSet,
  PlayEventAppend,
  PlaylistCreate,
  PlaylistPatch,
  PlaylistEntryAdd,
  PlaylistEntryPatch,
  SourcePreferenceSet,
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

// Server replicas also exchange the catalog input and the sources

/** An HLC, or empty for a source row from before server replication */
const SourceClock = Schema.Union([HybridLogicalClock, Schema.Literal("")]);

export class CatalogAssertionRow extends Schema.Class<CatalogAssertionRow>("CatalogAssertionRow")({
  table: Schema.Literal("catalog_assertion"),
  id: Uuid,
  workspaceId: Uuid,
  entityType: Schema.String,
  entityId: Schema.String,
  field: Schema.String,
  /** JSON. Null states that the origin has no value. */
  value: Schema.Unknown,
  origin: Schema.Literals(["admin", "musicbrainz", "provider", "local", "match", "parse"]),
  originRef: Schema.String,
  originRevision: Schema.NullOr(Schema.String),
  evidence: Schema.Unknown,
  confidence: Schema.Finite,
  authorUserId: Schema.NullOr(Schema.String),
  authorReplicaId: Schema.String,
  hlc: HybridLogicalClock,
  retracted: Schema.Boolean,
  schemaVersion: Schema.Int,
}) {}

export class EntityMergeRow extends Schema.Class<EntityMergeRow>("EntityMergeRow")({
  table: Schema.Literal("entity_merge"),
  id: Uuid,
  entityType: Schema.Literals(["artist", "recording", "release_group", "release", "track"]),
  fromId: Schema.String,
  intoId: Schema.String,
  decision: Schema.Literals(["merge", "reject"]),
  origin: Schema.Literals(["system", "admin"]),
  method: Schema.Literals(["mbid_tag", "isrc", "mapper", "manual", "shared_recording", "url_rel"]),
  confidence: Schema.Finite,
  evidence: Schema.Unknown,
  authorUserId: Schema.NullOr(Schema.String),
  hlc: HybridLogicalClock,
}) {}

export class SourceInputRow extends Schema.Class<SourceInputRow>("SourceInputRow")({
  table: Schema.Literal("source"),
  ...SourceRow.fields,
  hlc: SourceClock,
}) {}

export class SourceVariantInputRow extends Schema.Class<SourceVariantInputRow>(
  "SourceVariantInputRow",
)({
  table: Schema.Literal("source_variant"),
  ...SourceVariantRow.fields,
  hlc: SourceClock,
}) {}

/** One row of the catalog input that server replicas exchange. Clients never receive it. */
export const CatalogInputRow = Schema.Union([
  CatalogAssertionRow,
  EntityMergeRow,
  SourceInputRow,
  SourceVariantInputRow,
]);
export type CatalogInputRow = typeof CatalogInputRow.Type;

/** A linked provider account, without its credential. Each write sets all fields. */
export class ProviderAccountRow extends Schema.Class<ProviderAccountRow>("ProviderAccountRow")({
  table: Schema.Literal("provider_account"),
  id: Uuid,
  userId: UserId,
  provider: Schema.String,
  displayName: Schema.String,
  createdAt: Schema.Int,
  deleted: Schema.Boolean,
  hlc: HybridLogicalClock,
}) {}

/** One row that a server replica sends to another, without its `change_seq` */
export const PeerRow = Schema.Union([SyncRow, CatalogInputRow, ProviderAccountRow]);
export type PeerRow = typeof PeerRow.Type;

/** A position in the rows of a server, in `(change_seq, table, id)` order */
export class PeerCursor extends Schema.Class<PeerCursor>("PeerCursor")({
  changeSeq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** `<table>:<id>` of the last row when a page ended inside the rows of `changeSeq` */
  rowKey: Schema.NullOr(Schema.String),
}) {}

export class PeerPullRequest extends Schema.Class<PeerPullRequest>("PeerPullRequest")({
  protocolVersion: Schema.Int,
  /** The last epoch of the peer that the caller saw. Another epoch starts from the beginning. */
  epoch: Schema.NullOr(Uuid),
  cursor: PeerCursor,
}) {}

export class PeerPullResponse extends Schema.Class<PeerPullResponse>("PeerPullResponse")({
  replicaId: ReplicaId,
  workspaceId: WorkspaceId,
  epoch: Uuid,
  rows: Schema.Array(PeerRow),
  cursor: PeerCursor,
  more: Schema.Boolean,
}) {}

export class PeerPushRequest extends Schema.Class<PeerPushRequest>("PeerPushRequest")({
  protocolVersion: Schema.Int,
  rows: Schema.Array(PeerRow).check(Schema.isMaxLength(1000)),
}) {}

export class PeerRedeemRequest extends Schema.Class<PeerRedeemRequest>("PeerRedeemRequest")({
  code: Schema.String.check(Schema.isMaxLength(20)),
  /** The replica that redeems the code */
  replicaId: ReplicaId,
  /** The workspace of the redeeming replica. `null`: it joins the workspace of this server. */
  workspaceId: Schema.NullOr(WorkspaceId),
  protocolVersion: Schema.Int,
}) {}

/** The admin who made the pairing code. A server that joins makes its first admin with this ID. */
export class PeerAdmin extends Schema.Class<PeerAdmin>("PeerAdmin")({
  id: UserId,
  username: Schema.String,
  role: Schema.Literals(["admin", "member"]),
}) {}

export class PeerLink extends Schema.Class<PeerLink>("PeerLink")({
  /** The redeeming server keeps it secret. The other server stores only its hash. */
  token: Schema.String,
  replicaId: ReplicaId,
  workspaceId: WorkspaceId,
  admin: PeerAdmin,
}) {}

/** A paired server replica, as an admin sees it */
export class ServerPeer extends Schema.Class<ServerPeer>("ServerPeer")({
  replicaId: ReplicaId,
  /** Set when this server connects to the peer, null when the peer connects to this server */
  url: Schema.NullOr(Schema.String),
  /** This server pulls from and pushes to the peer */
  connects: Schema.Boolean,
  /** The peer connects to this server with a token */
  accepts: Schema.Boolean,
  syncedAt: Schema.NullOr(Schema.Number),
  /** For example `unreachable`, or `revoked` after the peer unpaired */
  error: Schema.NullOr(Schema.String),
}) {}

export class ServerPairingFailed extends Schema.TaggedError<ServerPairingFailed>()(
  "ServerPairingFailed",
  {
    reason: Schema.Literals([
      "not_admin",
      "invalid_code",
      "workspace_mismatch",
      "same_server",
      "unreachable",
      "upgrade_required",
      "not_found",
    ]),
  },
) {}
