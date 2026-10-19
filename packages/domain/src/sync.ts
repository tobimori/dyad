import { Effect, Schema } from "effect";

import { DeviceId, PlayContext, RecordingId, ReplicaId, WorkspaceId } from "./primitives.ts";

/** Two replicas sync only when they have the same version */
export const syncProtocolVersion = 14;

/**
 * Hybrid logical clock value: `<wall ms, 15 digits>-<counter, 4 base-36 digits>-<replica_id>`.
 * Values sort as strings. The replica ID makes values from different replicas unique.
 */
export const HybridLogicalClock = Schema.String.check(
  Schema.isPattern(/^\d{15}-[0-9a-z]{4}-[0-9a-f-]{36}$/),
).pipe(Schema.brand("HybridLogicalClock"));
export type HybridLogicalClock = typeof HybridLogicalClock.Type;

const Uuid = Schema.String.check(Schema.isUUID());

/** What the owner can add to the library: a song, an album (provider release) or an artist */
export const LibraryEntityType = Schema.Literals(["recording", "album", "artist"]);
export type LibraryEntityType = typeof LibraryEntityType.Type;

/**
 * `user` for a save in Dyad, `account:<provider>` for an import from a linked account, `album:<album
 * ID>` for the songs of a saved album
 */
export const LibraryOrigin = Schema.String.check(
  Schema.isPattern(/^(user|account:.+|album:.+)$/),
  Schema.isMaxLength(200),
);

/**
 * `favorite` includes saved; `disliked` and `removed` are not in the library. A `removed` user row
 * keeps an import from adding the entity again.
 */
export const LibraryMark = Schema.Literals(["saved", "favorite", "disliked", "removed"]);
export type LibraryMark = typeof LibraryMark.Type;

/** One library mark of one origin. Each write sets all fields. */
export class LibraryItemRow extends Schema.Class<LibraryItemRow>("LibraryItemRow")({
  table: Schema.Literal("library_item"),
  /** UUIDv5 of `library_item:<entity_type>:<entity_id>:<origin>` */
  id: Uuid,
  entityType: LibraryEntityType,
  /** The bound recording, album or artist that the owner marked, not its merge root */
  entityId: Uuid,
  origin: LibraryOrigin,
  mark: LibraryMark,
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

/** How the owner orders the sources of a recording. Each write sets all fields. */
export class SourcePreferenceRow extends Schema.Class<SourcePreferenceRow>("SourcePreferenceRow")({
  table: Schema.Literal("source_preference"),
  /** UUIDv5 of `source_preference:<scope>` */
  id: Uuid,
  scope: Schema.Literal("global"),
  /** Providers that it leaves out come after the others */
  providerRanking: ProviderRanking,
  hlc: HybridLogicalClock,
}) {}

/** One row of a synced table, without the server's `change_seq` */
export const SyncRow = Schema.Union([
  LibraryItemRow,
  PlaylistRow,
  PlaylistEntryRow,
  PlayEventRow,
  SourcePreferenceRow,
]);
export type SyncRow = typeof SyncRow.Type;

export class SourceRow extends Schema.Class<SourceRow>("SourceRow")({
  id: Uuid,
  provider: Schema.String,
  externalId: Schema.String,
  kind: Schema.Literals(["stream", "live", "file", "purchase"]),
  recordingId: Schema.NullOr(RecordingId),
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

export const PlaylistName = Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(200));

/** Rows of the replica changed. Views load again. */
export class SyncHint extends Schema.Class<SyncHint>("SyncHint")({}) {}

/** The client and the server have different sync protocol versions */
export class UpgradeRequired extends Schema.TaggedError<UpgradeRequired>()("UpgradeRequired", {
  serverProtocolVersion: Schema.Int,
}) {}

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
  authorReplicaId: Schema.String,
  hlc: HybridLogicalClock,
  retracted: Schema.Boolean,
  schemaVersion: Schema.Int,
}) {}

export class EntityMergeRow extends Schema.Class<EntityMergeRow>("EntityMergeRow")({
  table: Schema.Literal("entity_merge"),
  id: Uuid,
  entityType: Schema.Literals(["artist", "recording", "album", "edition"]),
  fromId: Schema.String,
  intoId: Schema.String,
  decision: Schema.Literals(["merge", "reject"]),
  origin: Schema.Literals(["system", "admin"]),
  method: Schema.Literals([
    "mbid_tag",
    "isrc",
    "mapper",
    "manual",
    "shared_recording",
    "url_rel",
    "upc",
    "edition_rule",
    "name_search",
    "artist_title",
  ]),
  confidence: Schema.Finite,
  evidence: Schema.Unknown,
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
  provider: Schema.String,
  displayName: Schema.String,
  createdAt: Schema.Int,
  deleted: Schema.Boolean,
  hlc: HybridLogicalClock,
}) {}

/** A song of a linked provider library, with the fields to show while it has no source */
export class LibraryRemoteTrackRow extends Schema.Class<LibraryRemoteTrackRow>(
  "LibraryRemoteTrackRow",
)({
  table: Schema.Literal("library_remote_track"),
  /** `<provider>:<recording_id>` */
  id: Schema.String,
  provider: Schema.String,
  recordingId: Uuid,
  remoteId: Schema.String,
  catalogId: Schema.NullOr(Schema.String),
  sourceId: Schema.NullOr(Schema.String),
  rawTitle: Schema.String,
  rawArtist: Schema.NullOr(Schema.String),
  rawAlbum: Schema.NullOr(Schema.String),
  rawDurationMs: Schema.NullOr(Schema.Number),
  deleted: Schema.Boolean,
  hlc: HybridLogicalClock,
}) {}

/** One row that a server replica sends to another, without its `change_seq` */
export const PeerRow = Schema.Union([
  SyncRow,
  CatalogInputRow,
  ProviderAccountRow,
  LibraryRemoteTrackRow,
]);
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

export class PeerLink extends Schema.Class<PeerLink>("PeerLink")({
  /** The redeeming server keeps it secret. The other server stores only its hash. */
  token: Schema.String,
  replicaId: ReplicaId,
  workspaceId: WorkspaceId,
}) {}

/** A paired server replica */
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
      "invalid_code",
      "workspace_mismatch",
      "same_server",
      "unreachable",
      "upgrade_required",
      "not_found",
    ]),
  },
) {}
