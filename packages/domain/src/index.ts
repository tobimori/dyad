import { Context, Schema } from "effect";
import { Rpc, RpcGroup, RpcMiddleware } from "effect/rpc";

export const HttpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : "Expected an HTTP or HTTPS URL",
  ),
);

export const ReplicaId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ReplicaId"));
export type ReplicaId = typeof ReplicaId.Type;

export const WorkspaceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const RecordingId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("RecordingId"));
export type RecordingId = typeof RecordingId.Type;

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

export class SourceSummary extends Schema.Class<SourceSummary>("SourceSummary")({
  id: Schema.String,
  /** `local` for a file on the server, else the provider name, for example `apple_music` */
  provider: Schema.String,
  title: Schema.NullOr(Schema.String),
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Number),
  codec: Schema.String,
  /** Cover image on the provider's server. `null` for local files and for sources without art. */
  artworkUrl: Schema.NullOr(Schema.String),
}) {}

/** Search results, best first */
export class SearchResults extends Schema.Class<SearchResults>("SearchResults")({
  sources: Schema.Array(SourceSummary),
}) {}

/** Where the user started a play */
export const PlayContext = Schema.Literals(["library", "search", "history"]);

export const AudioContainer = Schema.Literals(["mp3", "flac", "mp4", "adts", "ogg", "webm"]);
export const AudioCodec = Schema.Literals(["mp3", "flac", "aac", "alac", "opus", "vorbis"]);

/** A supported container/codec combination, not two independent format lists */
export class AudioFormat extends Schema.Class<AudioFormat>("AudioFormat")({
  container: AudioContainer,
  codec: AudioCodec,
}) {}

export class PlaybackCapabilities extends Schema.Class<PlaybackCapabilities>(
  "PlaybackCapabilities",
)({
  formats: Schema.NonEmptyArray(AudioFormat),
}) {}

export class PlaybackPlan extends Schema.Class<PlaybackPlan>("PlaybackPlan")({
  format: AudioFormat,
  /** Relative URL for the negotiated stream */
  path: Schema.String,
}) {}

export class PlaybackUnavailable extends Schema.TaggedError<PlaybackUnavailable>()(
  "PlaybackUnavailable",
  {
    reason: Schema.Literals(["not_found", "unsupported_format", "account_required"]),
  },
) {}

/**
 * The client opens `url` in a browser where the user signs in on the provider's own page. When
 * the browser has all `cookies` of `domain`, the client gives their values to `linkAccount`.
 */
export class BrowserLogin extends Schema.Class<BrowserLogin>("BrowserLogin")({
  // The client gives `url` to the browser as an argument, so it must not look like a flag
  url: Schema.String.check(
    Schema.makeFilter((url) =>
      URL.parse(url)?.protocol === "https:" ? undefined : "Expected an HTTPS URL",
    ),
  ),
  domain: Schema.String,
  cookies: Schema.NonEmptyArray(Schema.String),
}) {}

export class AccountProviderSummary extends Schema.Class<AccountProviderSummary>(
  "AccountProviderSummary",
)({
  provider: Schema.String,
  name: Schema.String,
  login: BrowserLogin,
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

export const UserId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const DeviceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("DeviceId"));
export type DeviceId = typeof DeviceId.Type;

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

const PublicRpc = RpcGroup.make(
  Rpc.make("describe", { success: ServerDescriptor }),
  /** Creates the first admin with the setup code from the server log */
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
  /** Adds a device with a code from `createPairingCode` on a device of the same user */
  Rpc.make("pair", {
    payload: { code: Schema.String, deviceName: DeviceName },
    success: DeviceSession,
    error: AuthenticationFailed,
  }),
);

const UserRpc = RpcGroup.make(
  Rpc.make("listSources", { success: Schema.Array(SourceSummary) }),
  /** The sources that the user played and can still play, newest play first, one entry per source */
  Rpc.make("listRecentPlays", { success: Schema.Array(SourceSummary) }),
  /**
   * Streams the complete ranked list again each time that a provider answers; the last list is
   * final. Clients replace their list. Every result can play at once with `preparePlayback`.
   */
  Rpc.make("search", {
    payload: { query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)) },
    success: SearchResults,
    stream: true,
  }),
  Rpc.make("preparePlayback", {
    payload: {
      sourceId: Schema.String.check(Schema.isUUID()),
      capabilities: PlaybackCapabilities,
    },
    success: PlaybackPlan,
    error: PlaybackUnavailable,
  }),
  /** Records one play when the source ends, or when the user skips it, plays another or quits */
  Rpc.make("recordPlay", {
    payload: {
      sourceId: Schema.String.check(Schema.isUUID()),
      startedAt: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      playedMs: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      completed: Schema.Boolean,
      context: PlayContext,
    },
  }),
  Rpc.make("createPairingCode", { success: PairingCode }),
  Rpc.make("listDevices", { success: Schema.Array(DeviceSummary) }),
  /** Removes a device of the current user, also the current device */
  Rpc.make("removeDevice", { payload: { deviceId: DeviceId } }),
  Rpc.make("listAccountProviders", { success: Schema.Array(AccountProviderSummary) }),
  Rpc.make("listAccounts", { success: Schema.Array(ProviderAccountSummary) }),
  /** Replaces an existing account of the same provider */
  Rpc.make("linkAccount", {
    payload: {
      provider: Schema.String,
      credentials: Schema.Record(Schema.String, Schema.String),
    },
    success: ProviderAccountSummary,
    error: AccountLinkFailed,
  }),
  /** Removes the account and its stored credentials from this server */
  Rpc.make("unlinkAccount", { payload: { provider: Schema.String } }),
).middleware(Authentication);

export class ServerRpc extends PublicRpc.merge(UserRpc) {}

export class WorkerDescriptor extends Schema.Class<WorkerDescriptor>("WorkerDescriptor")({
  execution: Schema.Literal("worker"),
  secureContext: Schema.Boolean,
  persistentStorageAvailable: Schema.Boolean,
}) {}

export class CoreWorkerRpc extends RpcGroup.make(
  Rpc.make("describe", { success: WorkerDescriptor }),
  Rpc.make("server", { success: Schema.NullOr(ServerDescriptor) }),
) {}
