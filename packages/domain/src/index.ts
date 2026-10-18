import { Context, Effect, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

import {
  DeviceId,
  PlayContext,
  RecordingId,
  ReplicaId,
  UserId,
  WorkspaceId,
} from "./primitives.ts";
import {
  PeerLink,
  PeerPullRequest,
  PeerPullResponse,
  PeerPushRequest,
  PeerRedeemRequest,
  PlaylistLink,
  PlaylistLinkState,
  ReplicaMismatch,
  ServerPairingFailed,
  ServerPeer,
  SyncHint,
  SyncPullRequest,
  SyncPullResponse,
  SyncPushRequest,
  SyncPushResponse,
  UpgradeRequired,
} from "./sync.ts";

export * from "./library-view.ts";
export * from "./primitives.ts";
export * from "./session.ts";
export * from "./sync.ts";
export * from "./timed.ts";

export const HttpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : "Expected an HTTP or HTTPS URL",
  ),
);

export class ServerDescriptor extends Schema.Class<ServerDescriptor>("ServerDescriptor")({
  replicaId: ReplicaId,
  workspaceId: WorkspaceId,
  protocolVersion: Schema.Literal(1),
  capabilities: Schema.Struct({
    replication: Schema.Boolean,
    playback: Schema.Boolean,
    providerSync: Schema.Boolean,
  }),
}) {}

/**
 * An opaque page ref, for example `apple_music:657515`. Clients never parse refs. They get them in
 * `SourceSummary` and in cards, and a client replica builds library refs with `libraryArtistRef`.
 */
export const ArtistRef = Schema.String.pipe(Schema.brand("ArtistRef"));
export type ArtistRef = typeof ArtistRef.Type;

/** An opaque page ref that the server makes, like `ArtistRef` */
export const AlbumRef = Schema.String.pipe(Schema.brand("AlbumRef"));
export type AlbumRef = typeof AlbumRef.Type;

export class SourceSummary extends Schema.Class<SourceSummary>("SourceSummary")({
  id: Schema.String,
  /** `local` for a file on the server, else the provider ID, for example `apple_music` */
  provider: Schema.String,
  title: Schema.NullOr(Schema.String),
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  codec: Schema.String,
  /** Cover image on the provider's server. `null` for local files and for sources without art. */
  artworkUrl: Schema.NullOr(Schema.String),
  // The decoding defaults keep queues decodable that clients saved before these fields existed
  artistRef: Schema.NullOr(ArtistRef).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  albumRef: Schema.NullOr(AlbumRef).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  explicit: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** Display name of `provider`, for example `Apple Music`. `null` for local files. */
  providerName: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** The bound recording, which a playlist entry saves. `null` when the server cannot tell it. */
  recordingId: Schema.NullOr(RecordingId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** `prepareVideo` gives a moving picture, like a music video. Client replicas do not know it. */
  video: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

/** `YYYY`, `YYYY-MM` or `YYYY-MM-DD` */
export const PartialDate = Schema.String.check(Schema.isPattern(/^\d{4}(-\d{2}(-\d{2})?)?$/));

/** The same values as `release_group.primary_type` */
export const ReleaseType = Schema.Literals(["album", "single", "ep"]);
export const SecondaryType = Schema.Literals(["compilation", "live"]);

export class AlbumCard extends Schema.Class<AlbumCard>("AlbumCard")({
  ref: AlbumRef,
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
  artistRef: Schema.NullOr(ArtistRef),
  releaseDate: Schema.NullOr(PartialDate),
  /** `null`: unclassified, which is not the same as an album */
  primaryType: Schema.NullOr(ReleaseType),
  secondaryTypes: Schema.Array(SecondaryType),
  explicit: Schema.Boolean,
  trackCount: Schema.NullOr(Schema.Int),
  artworkUrl: Schema.NullOr(Schema.String),
}) {}

export class ArtistCard extends Schema.Class<ArtistCard>("ArtistCard")({
  ref: ArtistRef,
  name: Schema.String,
  artworkUrl: Schema.NullOr(Schema.String),
}) {}

export class PageTrack extends Schema.Class<PageTrack>("PageTrack")({
  source: SourceSummary,
  disc: Schema.NullOr(Schema.Int),
  number: Schema.NullOr(Schema.Int),
  /** `false`: the provider does not stream it, for example outside the storefront */
  playable: Schema.Boolean,
  /** Why Dyad suggests the track, for example `Because you played Song`. Safe to show. */
  reason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

// The section kinds are fixed and do not depend on the provider. Clients map a kind to a heading.

export class TrackSection extends Schema.TaggedClass<TrackSection>()("TrackSection", {
  kind: Schema.Literals(["top_tracks", "tracks"]),
  tracks: Schema.Array(PageTrack),
}) {}

export class AlbumSection extends Schema.TaggedClass<AlbumSection>()("AlbumSection", {
  /** Newest first. Clients call `other` "Releases" when it is the only album section. */
  kind: Schema.Literals([
    "albums",
    "singles_eps",
    "compilations",
    "live",
    "appears_on",
    "in_library",
    "other",
  ]),
  albums: Schema.Array(AlbumCard),
}) {}

export class ArtistSection extends Schema.TaggedClass<ArtistSection>()("ArtistSection", {
  kind: Schema.Literal("similar_artists"),
  artists: Schema.Array(ArtistCard),
}) {}

export const PageSection = Schema.Union([TrackSection, AlbumSection, ArtistSection]);

/**
 * `local`: built from the data on the server. `fetching` without `fetchedAt`: not fetched yet.
 * `failed` with `fetchedAt`: the page shows old data.
 */
export class PageState extends Schema.Class<PageState>("PageState")({
  status: Schema.Literals(["local", "fetching", "fresh", "failed"]),
  fetchedAt: Schema.NullOr(Schema.Int),
  /** Safe to show */
  reason: Schema.NullOr(Schema.String),
}) {}

export class ArtistPage extends Schema.Class<ArtistPage>("ArtistPage")({
  /** The canonical ref, which can differ from the requested ref */
  ref: ArtistRef,
  /** `null` for a library page */
  providerName: Schema.NullOr(Schema.String),
  name: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
  sections: Schema.Array(PageSection),
  state: PageState,
}) {}

export class AlbumPage extends Schema.Class<AlbumPage>("AlbumPage")({
  /** The canonical ref, which can differ from the requested ref */
  ref: AlbumRef,
  /** `null` for a library page */
  providerName: Schema.NullOr(Schema.String),
  album: Schema.NullOr(AlbumCard),
  tracks: Schema.Array(PageTrack),
  state: PageState,
}) {}

/** No page has this ref, for example a library ref after a tag edit changed the keys */
export class PageNotFound extends Schema.TaggedError<PageNotFound>()("PageNotFound", {}) {}

export class HomeShelf extends Schema.Class<HomeShelf>("HomeShelf")({
  /** Safe to show, for example `Recent albums` or a chart name of a provider */
  title: Schema.String,
  tracks: Schema.Array(PageTrack),
  albums: Schema.Array(AlbumCard),
}) {}

/** The shelves from the plays on the server, from the user's recommenders, or from one provider */
export class HomeGroup extends Schema.Class<HomeGroup>("HomeGroup")({
  /** `null` for the shelves from the plays on the server and from the recommenders */
  providerName: Schema.NullOr(Schema.String),
  shelves: Schema.Array(HomeShelf),
  state: PageState,
}) {}

export class HomePage extends Schema.Class<HomePage>("HomePage")({
  groups: Schema.Array(HomeGroup),
}) {}

/** What a radio starts from: a song or a DJ set, or an artist */
export const RadioStart = Schema.TaggedUnion({
  Source: { sourceId: Schema.String.check(Schema.isUUID()) },
  Artist: { name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) },
});

/**
 * Why the user cannot play a library entry. `library_only`: the song is only in the user's
 * provider library, for example an upload. `not_in_catalog`: the provider's catalog for the
 * user's country does not have the song. `account_required`: the user has no linked account for
 * its sources. `not_synced`: a client replica does not have the song's catalog rows yet.
 */
export const LibraryEntryUnavailable = Schema.Literals([
  "library_only",
  "not_in_catalog",
  "account_required",
  "not_synced",
]);

export class LibraryEntry extends Schema.Class<LibraryEntry>("LibraryEntry")({
  /** Two saved versions that matching merged give one entry */
  recordingId: RecordingId,
  title: Schema.NullOr(Schema.String),
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  artworkUrl: Schema.NullOr(Schema.String),
  addedAt: Schema.Int,
  /** The best source that the user can play. `null` when `unavailable` is set. */
  source: Schema.NullOr(SourceSummary),
  sourceCount: Schema.Int,
  unavailable: Schema.NullOr(LibraryEntryUnavailable),
}) {}

export class PlaylistEntry extends LibraryEntry.extend<PlaylistEntry>("PlaylistEntry")({
  /** Unique in the playlist. The same recording can be in a playlist more than once. */
  entryId: Schema.String,
  /** The playlist has a `two-way` link, and its provider has no source of the recording */
  dyadOnly: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
}) {}

export class PlaylistSummary extends Schema.Class<PlaylistSummary>("PlaylistSummary")({
  id: Schema.String,
  name: Schema.String,
  entryCount: Schema.Int,
  link: Schema.NullOr(PlaylistLink),
  linkState: Schema.NullOr(PlaylistLinkState),
}) {}

export class PlaylistNotFound extends Schema.TaggedError<PlaylistNotFound>()(
  "PlaylistNotFound",
  {},
) {}

export class MergeFailed extends Schema.TaggedError<MergeFailed>()("MergeFailed", {
  reason: Schema.Literals(["not_admin", "recording_not_found", "same_recording"]),
}) {}

/** One entry of the tracklist of a DJ set, in the time of its source */
export class SourceSegment extends Schema.Class<SourceSegment>("SourceSegment")({
  /** `null` when the tracklist gives no time. Clients cannot seek to the entry. */
  startMs: Schema.NullOr(Schema.Number),
  endMs: Schema.NullOr(Schema.Number),
  /** Of the matched recording, else as the tracklist shows it, for example `ID` */
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  /** The pages of a source of the matched recording that the user can play */
  artistRef: Schema.NullOr(ArtistRef),
  albumRef: Schema.NullOr(AlbumRef),
  /** The matched recording, which a playlist entry can save */
  recordingId: Schema.NullOr(RecordingId).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

export class TracklistEditFailed extends Schema.TaggedError<TracklistEditFailed>()(
  "TracklistEditFailed",
  { reason: Schema.Literals(["not_admin", "source_not_found"]) },
) {}

export class LibrarySyncStatus extends Schema.Class<LibrarySyncStatus>("LibrarySyncStatus")({
  provider: Schema.String,
  /**
   * `pending`: no run has ended yet. `needs_relink`: the provider rejected the account, and the
   * import stops until the user links it again. `throttled`: the next run waits longer.
   */
  status: Schema.Literals(["pending", "ok", "needs_relink", "throttled", "error"]),
  running: Schema.Boolean,
  /** `lastCompleteAt`: the last read that saw all songs */
  lastCompleteAt: Schema.NullOr(Schema.Int),
  lastAttemptAt: Schema.NullOr(Schema.Int),
  nextRunAt: Schema.NullOr(Schema.Int),
  /**
   * Why the last read did not see all songs, for example `read 903 of 904 songs`. Then the import
   * adds songs but removes none. Safe to show, like `error`.
   */
  incompleteReason: Schema.NullOr(Schema.String),
  error: Schema.NullOr(Schema.String),
  itemCount: Schema.Int,
  notPlayableCount: Schema.Int,
}) {}

/** Search results, best first */
export class SearchResults extends Schema.Class<SearchResults>("SearchResults")({
  sources: Schema.Array(SourceSummary),
  /** Names of the providers that failed or did not answer in time, for example `Apple Music` */
  unavailable: Schema.Array(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
}) {}

export const AudioContainer = Schema.Literals(["mp3", "flac", "mp4", "adts", "ogg", "webm"]);
export const AudioCodec = Schema.Literals(["mp3", "flac", "aac", "alac", "opus", "vorbis"]);

/** A supported container/codec combination, not two independent format lists */
export class AudioFormat extends Schema.Class<AudioFormat>("AudioFormat")({
  container: AudioContainer,
  codec: AudioCodec,
}) {}

/** What the server knows of some audio. `null` fields are unknown. */
export class AudioQuality extends Schema.Class<AudioQuality>("AudioQuality")({
  /** FFmpeg name, which can be a codec that no client decodes, for example `wavpack` */
  codec: Schema.String,
  lossless: Schema.Boolean,
  sampleRate: Schema.NullOr(Schema.Int),
  bitDepth: Schema.NullOr(Schema.Int),
  /** In bit/s */
  bitrate: Schema.NullOr(Schema.Int),
}) {}

export class PlaybackCapabilities extends Schema.Class<PlaybackCapabilities>(
  "PlaybackCapabilities",
)({
  formats: Schema.NonEmptyArray(AudioFormat),
}) {}

/** Measured by the server from the full decoded audio */
export class AudioAnalysis extends Schema.Class<AudioAnalysis>("AudioAnalysis")({
  /** Integrated loudness in LUFS (EBU R128) */
  loudness: Schema.Finite,
  /** In dBTP */
  truePeak: Schema.Finite,
  /** Time before the first sample above −60 dBFS */
  leadingSilenceMs: Schema.Int,
  /** Time after the last sample above −60 dBFS */
  trailingSilenceMs: Schema.Int,
}) {}

export class PlaybackPlan extends Schema.Class<PlaybackPlan>("PlaybackPlan")({
  format: AudioFormat,
  /** `null` until the server has analyzed the audio. Ask again later for it. */
  analysis: Schema.NullOr(AudioAnalysis),
  /**
   * Relative URL for the negotiated stream. The query parameter `start=<ms>` starts it at that
   * position; MP3 and ADTS output can start some frames early.
   */
  path: Schema.String,
  /**
   * The audio of the source. When `format.codec` is another codec, the server transcodes it.
   * `null` from older servers.
   */
  source: Schema.NullOr(AudioQuality).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

export class VideoPlan extends Schema.Class<VideoPlan>("VideoPlan")({
  /**
   * Relative URL of VP9 video without audio in WebM, on the timeline of the source's audio. The
   * query parameter `start=<ms>` starts it at the keyframe cluster at or before that position.
   */
  path: Schema.String,
}) {}

export class PlaybackUnavailable extends Schema.TaggedError<PlaybackUnavailable>()(
  "PlaybackUnavailable",
  {
    reason: Schema.Literals(["not_found", "unsupported_format", "account_required"]),
  },
) {}

/**
 * `lossless` is 16-bit FLAC; `high`, `normal` and `data_saver` are lossy targets of about 256, 128
 * and 64 kbps. A lossy source never becomes lossless, and a source at or below the target stays as
 * it is.
 */
export const DownloadQuality = Schema.Literals([
  "original",
  "lossless",
  "high",
  "normal",
  "data_saver",
]);

export class DownloadPlan extends Schema.Class<DownloadPlan>("DownloadPlan")({
  format: AudioFormat,
  /** In bit/s. `null` when the file keeps the audio of the source or is lossless. */
  bitrate: Schema.NullOr(Schema.Int),
  /** Relative URL of the file */
  path: Schema.String,
  /** Server time when the device deletes the file unless a check-in renews it. `null`: no lease. */
  leaseExpiresAt: Schema.NullOr(Schema.Number),
  /** The audio of the file. `null` from older servers. */
  audio: Schema.NullOr(AudioQuality).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

export class DownloadLease extends Schema.Class<DownloadLease>("DownloadLease")({
  sourceId: Schema.String,
  leaseExpiresAt: Schema.NullOr(Schema.Number),
}) {}

/** `not_allowed`: the provider does not let devices keep its audio */
export class DownloadUnavailable extends Schema.TaggedError<DownloadUnavailable>()(
  "DownloadUnavailable",
  {
    reason: Schema.Literals(["not_found", "unsupported_format", "account_required", "not_allowed"]),
  },
) {}

/** Clients import only the declared cookies of `domain` and send them to `linkAccount` */
export class BrowserLogin extends Schema.Class<BrowserLogin>("BrowserLogin")({
  /** The sign-in page that clients show. HTTPS only, because the user signs in there. */
  url: Schema.String.check(
    Schema.makeFilter((url) =>
      URL.parse(url)?.protocol === "https:" ? undefined : "Expected an HTTPS URL",
    ),
  ),
  domain: Schema.String,
  cookies: Schema.NonEmptyArray(Schema.String),
  /** Defaults to all declared cookies; the provider can check additional rules */
  requiredCookies: Schema.optional(Schema.Array(Schema.String)),
}) {}

/** Clients ask for a token that the user copies from `url`, and send it as `token` to `linkAccount` */
export class TokenLogin extends Schema.TaggedClass<TokenLogin>()("TokenLogin", {
  /** The page that shows the token. HTTPS only. */
  url: BrowserLogin.fields.url,
  /** The provider's name of the token, for example `user token` */
  label: Schema.String,
}) {}

export class AccountProviderSummary extends Schema.Class<AccountProviderSummary>(
  "AccountProviderSummary",
)({
  provider: Schema.String,
  name: Schema.String,
  login: Schema.Union([BrowserLogin, TokenLogin]),
  /** A new playlist can have a two-way link to a new playlist of the provider */
  createsPlaylists: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}) {}

export class ProviderAccountSummary extends Schema.Class<ProviderAccountSummary>(
  "ProviderAccountSummary",
)({
  provider: Schema.String,
  displayName: Schema.String,
}) {}

/** `reason` is safe to show; it never contains the credentials */
export class AccountLinkFailed extends Schema.TaggedError<AccountLinkFailed>()(
  "AccountLinkFailed",
  { reason: Schema.String },
) {}

const Username = Schema.String.check(Schema.isPattern(/^[a-z0-9._-]{1,64}$/));
const DeviceName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100));
// The upper limit only bounds the request size. HMAC hashes a long password once, so the length
// does not make each PBKDF2 iteration slower.
const Password = Schema.String.check(Schema.isMinLength(8), Schema.isMaxLength(1024));

/** The user and device of an authenticated request */
export class Principal extends Schema.Class<Principal>("Principal")({
  userId: UserId,
  deviceId: DeviceId,
}) {}

export class CurrentPrincipal extends Context.Service<CurrentPrincipal, Principal>()(
  "@dyad/domain/CurrentPrincipal",
) {}

export class Unauthorized extends Schema.TaggedError<Unauthorized>()("Unauthorized", {}) {}

export class AuthenticationFailed extends Schema.TaggedError<AuthenticationFailed>()(
  "AuthenticationFailed",
  {
    reason: Schema.Literals(["invalid_credentials", "invalid_code", "already_set_up"]),
  },
) {}

/** Requires the `authorization: Bearer <device token>` header */
export class Authentication extends RpcMiddleware.Service<
  Authentication,
  { provides: CurrentPrincipal }
>()("@dyad/domain/Authentication", { error: Unauthorized, requiredForClient: true }) {}

export class DeviceSession extends Schema.Class<DeviceSession>("DeviceSession")({
  /** The device keeps this token secret. The server stores only its hash. */
  token: Schema.String,
  principal: Principal,
}) {}

export class PairingCode extends Schema.Class<PairingCode>("PairingCode")({
  code: Schema.String,
  expiresAt: Schema.Number,
}) {}

export class DeviceSummary extends Schema.Class<DeviceSummary>("DeviceSummary")({
  id: DeviceId,
  name: Schema.String,
  createdAt: Schema.Number,
  current: Schema.Boolean,
}) {}

/** Unique in the user's session. The server never uses an ID again, also after a restart. */
export const EntryId = Schema.Int.check(Schema.isGreaterThan(0)).pipe(Schema.brand("EntryId"));
export type EntryId = typeof EntryId.Type;

/** `device:<DeviceId>` for a Dyad device that plays */
export const OutputId = Schema.String.check(Schema.isMaxLength(256)).pipe(Schema.brand("OutputId"));
export type OutputId = typeof OutputId.Type;

export const RepeatMode = Schema.Literals(["off", "all", "one"]);

export class QueueEntry extends Schema.Class<QueueEntry>("QueueEntry")({
  id: EntryId,
  source: SourceSummary,
  context: PlayContext,
  /** The entry failed to play. Skips and ends pass over it; `JumpTo` tries it again. */
  unplayable: Schema.Boolean,
  /** Why a radio added the entry, for example `Because you played Song`. Safe to show. */
  reason: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

/** The transport of the user's session. `positionAt` gives the position at a server time. */
export class Playback extends Schema.Class<Playback>("Playback")({
  state: Schema.Literals(["stopped", "paused", "playing"]),
  /** Entries before it are the history that a skip back goes to */
  entryId: Schema.NullOr(EntryId),
  positionMs: Schema.Number,
  /** Server time of `positionMs` */
  at: Schema.Number,
  /** 0 while paused, while the output loads, and after a lost output passed the end of the entry */
  rate: Schema.Literals([0, 1]),
  /** Changes at each command that changes the transport, but not at the natural end of an entry */
  revision: Schema.Int,
  outputId: Schema.NullOr(OutputId),
  /** The other `timed` outputs that play in sync with `outputId` */
  group: Schema.Array(OutputId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The output stopped reporting and can still play from its buffer, or it did not start to play */
  lost: Schema.Boolean,
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  /** The session adds radio songs when the last entry plays and `repeat` is `off` */
  autoplay: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
    Schema.withConstructorDefault(Effect.succeed(true)),
  ),
}) {}

export class Output extends Schema.Class<Output>("Output")({
  id: OutputId,
  kind: Schema.Literals(["device", "url", "timed"]),
  name: Schema.String,
  /** 0 to 1, `null` when unknown */
  volume: Schema.NullOr(Schema.Number),
  muted: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
  /** A `timed` output plays this much later than the others in its group, or earlier when negative */
  delayMs: Schema.Number.pipe(Schema.withDecodingDefaultKey(Effect.succeed(0))),
  /** Can play in a group, in sync with the other members. Chromecast and plain UPnP cannot. */
  groupable: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
}) {}

/** Removes `remove` entries at `index`, then inserts `insert` there */
export class QueueSplice extends Schema.Class<QueueSplice>("QueueSplice")({
  index: Schema.Int,
  remove: Schema.Int,
  insert: Schema.Array(QueueEntry),
}) {}

export const SessionEvent = Schema.TaggedUnion({
  /**
   * Always the first event. Reports of this connection send `generation`. `serverTime` gives the
   * clock offset to the server.
   */
  Snapshot: {
    generation: Schema.Int,
    serverTime: Schema.Number,
    queueVersion: Schema.Int,
    entries: Schema.Array(QueueEntry),
    playback: Playback,
    outputs: Schema.Array(Output),
  },
  /** Apply only when `fromVersion` is the version of the local queue, else connect again */
  QueueChanged: {
    fromVersion: Schema.Int,
    version: Schema.Int,
    splices: Schema.Array(QueueSplice),
  },
  PlaybackChanged: { serverTime: Schema.Number, playback: Playback },
  OutputsChanged: { outputs: Schema.Array(Output) },
  /** A newer connection of the same device plays. This connection continues as a controller. */
  Superseded: {},
});

const SourceIds = Schema.NonEmptyArray(Schema.String.check(Schema.isUUID())).check(
  Schema.isMaxLength(10_000),
);

export const SessionCommand = Schema.TaggedUnion({
  /** Replaces the queue and plays `sourceIds[index]` */
  Play: {
    sourceIds: SourceIds,
    index: Schema.Int,
    context: PlayContext,
    shuffle: Schema.Boolean,
    /** `QueueEntry.reason` by source ID, from `radio` */
    reasons: Schema.optionalKey(
      Schema.Record(Schema.String, Schema.String.check(Schema.isMaxLength(200))),
    ),
  },
  Enqueue: {
    sourceIds: SourceIds,
    context: PlayContext,
    after: Schema.Union([Schema.Literals(["current", "end"]), EntryId]),
  },
  Remove: { entryIds: Schema.NonEmptyArray(EntryId) },
  /** `after: null` moves the entries to the start */
  Move: { entryIds: Schema.NonEmptyArray(EntryId), after: Schema.NullOr(EntryId) },
  Clear: { keepCurrent: Schema.Boolean },
  JumpTo: { entryId: EntryId, positionMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) },
  Resume: {},
  Pause: {},
  Stop: {},
  Seek: { entryId: EntryId, positionMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)) },
  /** Ignores `repeat: "one"`. Does nothing when `fromEntryId` is no longer the current entry. */
  Skip: { fromEntryId: EntryId, direction: Schema.Literals([1, -1]) },
  SetShuffle: { on: Schema.Boolean },
  SetRepeat: { mode: RepeatMode },
  SetAutoplay: { on: Schema.Boolean },
  /** `play: null` keeps the state. The session leaves its group. */
  Transfer: { outputId: OutputId, play: Schema.NullOr(Schema.Boolean) },
  /**
   * Plays on all `outputIds` in sync. Only `groupable` outputs. Outputs that play already continue,
   * and the others join; without one, it is a `Transfer`.
   */
  SetGroup: { outputIds: Schema.NonEmptyArray(OutputId).check(Schema.isMaxLength(32)) },
  SetOutputDelay: {
    outputId: OutputId,
    delayMs: Schema.Int.check(Schema.isBetween({ minimum: -2000, maximum: 2000 })),
  },
  SetVolume: {
    outputId: OutputId,
    volume: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  },
});

export class SessionCommandResult extends Schema.Class<SessionCommandResult>(
  "SessionCommandResult",
)({
  queueVersion: Schema.Int,
  revision: Schema.Int,
  /** The new entries of `Play` and `Enqueue` */
  entryIds: Schema.Array(EntryId),
}) {}

export class SessionCommandFailed extends Schema.TaggedError<SessionCommandFailed>()(
  "SessionCommandFailed",
  {
    reason: Schema.Literals([
      "stale_queue",
      "entry_not_found",
      "queue_full",
      "output_unavailable",
      "nothing_to_play",
    ]),
  },
) {}

/**
 * What a device played before it lost the server. The server continues from it only when the device
 * is still the output and nobody changed the transport since `revision`.
 */
export class PlayerResume extends Schema.Class<PlayerResume>("PlayerResume")({
  revision: Schema.Int,
  entryId: EntryId,
  positionMs: Schema.Number,
  state: Schema.Literals(["playing", "paused"]),
  /** The entries that ended by themselves on the device while it was offline */
  advanced: Schema.Array(EntryId)
    .check(Schema.isMaxLength(10_000))
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** The play of `entryId` when it started offline. The server continues it when it adopts. */
  play: Schema.NullOr(Schema.Struct({ startedAt: Schema.Number, playedMs: Schema.Number })).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
}) {}

const PublicRpc = RpcGroup.make(
  Rpc.make("describe", { success: ServerDescriptor }),
  // Creates the first admin with the setup code from the server log
  Rpc.make("setup", {
    payload: {
      setupCode: Schema.String,
      username: Username,
      password: Password,
      deviceName: DeviceName,
    },
    success: DeviceSession,
    error: AuthenticationFailed,
  }),
  Rpc.make("login", {
    // Without the setup rules, so that a wrong input gives `invalid_credentials`
    payload: {
      username: Schema.String.check(Schema.isMaxLength(64)),
      password: Schema.String.check(Schema.isMaxLength(1024)),
      deviceName: DeviceName,
    },
    success: DeviceSession,
    error: AuthenticationFailed,
  }),
  // Adds a device with a code from `createPairingCode` on a device of the same user
  Rpc.make("pair", {
    payload: { code: Schema.String, deviceName: DeviceName },
    success: DeviceSession,
    error: AuthenticationFailed,
  }),
);

const UserRpc = RpcGroup.make(
  // The files on the server
  Rpc.make("listSources", { success: Schema.Array(SourceSummary) }),
  Rpc.make("listPlaylistEntries", {
    payload: { playlistId: Schema.String },
    success: Schema.Array(PlaylistEntry),
    error: PlaylistNotFound,
  }),
  Rpc.make("getLibrarySyncStatus", { success: Schema.Array(LibrarySyncStatus) }),
  // Returns at once; does nothing without a linked account
  Rpc.make("syncLibrary", { payload: { provider: Schema.String } }),
  // Streams the complete ranked list again each time that a provider answers; the last list is
  // final. Clients replace their list. Every result can play at once with `preparePlayback`.
  Rpc.make("search", {
    payload: { query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) },
    success: SearchResults,
    stream: true,
  }),
  // Streams the page again each time that it changes; the last emission is the current page. A
  // library ref gives one emission.
  Rpc.make("artistPage", {
    payload: { ref: ArtistRef },
    success: ArtistPage,
    error: PageNotFound,
    stream: true,
  }),
  Rpc.make("albumPage", {
    payload: { ref: AlbumRef },
    success: AlbumPage,
    error: PageNotFound,
    stream: true,
  }),
  // Streams the page again each time that a provider group changes, like `artistPage`
  Rpc.make("homePage", { success: HomePage, stream: true }),
  // Songs that follow the start, best first, each with a reason. The start itself is not in it.
  Rpc.make("radio", { payload: { start: RadioStart }, success: Schema.Array(PageTrack) }),
  // The album artists and the albums of the files on the server, sorted by name
  Rpc.make("listLibraryArtists", { success: Schema.Array(ArtistCard) }),
  Rpc.make("listLibraryAlbums", { success: Schema.Array(AlbumCard) }),
  Rpc.make("preparePlayback", {
    payload: {
      sourceId: Schema.String.check(Schema.isUUID()),
      capabilities: PlaybackCapabilities,
    },
    success: PlaybackPlan,
    error: PlaybackUnavailable,
  }),
  // The tallest video stream that is at most `maxHeight` pixels high, else the smallest.
  // `not_found` when the provider has no video. The URL answers 502 when the provider fails.
  Rpc.make("prepareVideo", {
    payload: {
      sourceId: Schema.String.check(Schema.isUUID()),
      maxHeight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4320 })),
    },
    success: VideoPlan,
    error: PlaybackUnavailable,
  }),
  // A `Snapshot` of the user's session, then its changes. A device that can play sends `player`;
  // the newest such connection of a device plays when the device is the output.
  Rpc.make("connectDevice", {
    payload: {
      player: Schema.NullOr(
        Schema.Struct({
          capabilities: PlaybackCapabilities,
          volume: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
        }),
      ),
      resume: Schema.NullOr(PlayerResume),
    },
    success: SessionEvent,
    stream: true,
  }),
  // A retry with the same `requestId` gets the first result and changes nothing.
  // `ifQueueVersion` is for commands that a client built from queue positions.
  Rpc.make("controlSession", {
    payload: {
      requestId: Schema.String.check(Schema.isUUID()),
      command: SessionCommand,
      ifQueueVersion: Schema.NullOr(Schema.Int),
    },
    success: SessionCommandResult,
    error: SessionCommandFailed,
  }),
  // From the output device, on each change and every 5 seconds while it plays. The server ignores
  // a report of an older connection or an older revision.
  Rpc.make("reportPlayback", {
    payload: {
      generation: Schema.Int,
      revision: Schema.Int,
      entryId: EntryId,
      state: Schema.Literals(["playing", "paused", "buffering", "ended", "failed"]),
      positionMs: Schema.Number,
      failure: Schema.NullOr(PlaybackUnavailable.fields.reason),
      volume: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
    },
  }),
  // The changed rows after the cursors of the client replica. Pull again while `more` is true.
  Rpc.make("syncPull", {
    payload: SyncPullRequest,
    success: SyncPullResponse,
    error: Schema.Union([UpgradeRequired, ReplicaMismatch]),
  }),
  Rpc.make("syncPush", {
    payload: SyncPushRequest,
    success: SyncPushResponse,
    error: Schema.Union([UpgradeRequired, ReplicaMismatch]),
  }),
  // Subscribe, then pull after each hint. The first hint comes when the subscription is ready.
  Rpc.make("syncWatch", { success: SyncHint, stream: true }),
  // A file that this device keeps, in one of the `capabilities` formats. The server records it
  // for the device until a check-in leaves it out.
  Rpc.make("prepareDownload", {
    payload: {
      sourceId: Schema.String.check(Schema.isUUID()),
      quality: DownloadQuality,
      capabilities: PlaybackCapabilities,
    },
    success: DownloadPlan,
    error: DownloadUnavailable,
  }),
  // All files that the device keeps or downloads. The device deletes the files that the answer
  // leaves out, for example after an unlink; the server forgets them too.
  Rpc.make("checkInDownloads", {
    payload: {
      sourceIds: Schema.Array(Schema.String.check(Schema.isUUID())).check(
        Schema.isMaxLength(100_000),
      ),
    },
    success: Schema.Array(DownloadLease),
  }),
  Rpc.make("createPairingCode", { success: PairingCode }),
  Rpc.make("listDevices", { success: Schema.Array(DeviceSummary) }),
  // Removes a device of the current user, also the current device. Its stream URLs stop working.
  Rpc.make("removeDevice", { payload: { deviceId: DeviceId } }),
  Rpc.make("listAccountProviders", { success: Schema.Array(AccountProviderSummary) }),
  Rpc.make("listAccounts", { success: Schema.Array(ProviderAccountSummary) }),
  // Replaces an existing account of the same provider
  Rpc.make("linkAccount", {
    payload: {
      provider: Schema.String,
      credentials: Schema.Record(Schema.String, Schema.String),
    },
    success: ProviderAccountSummary,
    error: AccountLinkFailed,
  }),
  // Removes the account and its stored credentials from this server, the songs and playlists that
  // it imported from the user's library, and the provider's downloads on the user's devices
  Rpc.make("unlinkAccount", { payload: { provider: Schema.String } }),
  // Admin only. Takes `fromId` out of the group of `intoId`. After this, the matcher never merges
  // `fromId` again; only `mergeRecordings` does.
  Rpc.make("unmergeRecording", {
    payload: { fromId: RecordingId, intoId: RecordingId },
    error: MergeFailed,
  }),
  // Admin only. Merges `fromId` into `intoId`, also against the matcher.
  Rpc.make("mergeRecordings", {
    payload: { fromId: RecordingId, intoId: RecordingId },
    error: MergeFailed,
  }),
  // The tracklist of a DJ set source, again after each change, for example when matching finds
  // a song. Empty for other sources.
  Rpc.make("sourceSegments", {
    payload: { sourceId: Schema.String.check(Schema.isUUID()) },
    success: Schema.Array(SourceSegment),
    stream: true,
  }),
  // Admin only. Hides the tracklists of the source for all users, or shows them again.
  Rpc.make("hideTracklist", {
    payload: { sourceId: Schema.String.check(Schema.isUUID()), hidden: Schema.Boolean },
    error: TracklistEditFailed,
  }),
  // Admin only. A code that another server redeems once to pair with this server.
  Rpc.make("createServerPairingCode", { success: PairingCode, error: ServerPairingFailed }),
  // Admin only. Redeems a code of the server at `url`, which must be in the same workspace. This
  // server then pulls from and pushes to it.
  Rpc.make("pairServer", {
    payload: { url: HttpUrl, code: Schema.String.check(Schema.isMaxLength(20)) },
    success: ServerPeer,
    error: ServerPairingFailed,
  }),
  Rpc.make("listServerPeers", { success: Schema.Array(ServerPeer), error: ServerPairingFailed }),
  // Admin only. Removes the pairing on both servers when the peer is reachable. Replicated data
  // stays.
  Rpc.make("unpairServer", { payload: { replicaId: ReplicaId }, error: ServerPairingFailed }),
).middleware(Authentication);

export class ServerRpc extends PublicRpc.merge(UserRpc) {}

/** The server replica of an authenticated peer request */
export class CurrentPeer extends Context.Service<CurrentPeer, ReplicaId>()(
  "@dyad/domain/CurrentPeer",
) {}

/** Requires the `authorization: Bearer <server token>` header from `peerRedeem` */
export class PeerAuthentication extends RpcMiddleware.Service<
  PeerAuthentication,
  { provides: CurrentPeer }
>()("@dyad/domain/PeerAuthentication", { error: Unauthorized, requiredForClient: true }) {}

/** Calls between paired server replicas, at `/peer`. Device tokens do not work here. */
export class PeerRpc extends RpcGroup.make(
  Rpc.make("peerRedeem", {
    payload: PeerRedeemRequest,
    success: PeerLink,
    error: Schema.Union([ServerPairingFailed, UpgradeRequired]),
  }),
).merge(
  RpcGroup.make(
    // The rows of all scopes after the cursor. Pull again while `more` is true.
    Rpc.make("peerPull", {
      payload: PeerPullRequest,
      success: PeerPullResponse,
      error: UpgradeRequired,
    }),
    Rpc.make("peerPush", { payload: PeerPushRequest, error: UpgradeRequired }),
    // Forgets the token of the caller
    Rpc.make("peerRevoke", {}),
  ).middleware(PeerAuthentication),
) {}

export class WorkerDescriptor extends Schema.Class<WorkerDescriptor>("WorkerDescriptor")({
  execution: Schema.Literal("worker"),
  secureContext: Schema.Boolean,
  persistentStorageAvailable: Schema.Boolean,
}) {}

export class CoreWorkerRpc extends RpcGroup.make(
  Rpc.make("describe", { success: WorkerDescriptor }),
  Rpc.make("server", { success: Schema.NullOr(ServerDescriptor) }),
) {}
