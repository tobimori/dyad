import { PartialDate, ReleaseType, SecondaryType } from "@dyad/domain";
import type { AccountLinkFailed, AudioFormat, BrowserLogin } from "@dyad/domain";
import { Data, Effect, Schema } from "effect";
import type { FileSystem, Path, Redacted, Scope, Stream } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import type { HttpClient } from "effect/http";

/** One artist of a credit, with the ID that the provider or MusicBrainz gives it */
export class CreditedArtist extends Schema.Class<CreditedArtist>("CreditedArtist")({
  id: Schema.String,
  name: Schema.String,
}) {}

/**
 * A playable item of a provider, for example one Apple Music song. The core stores it in the
 * provider cache of its replica, so it is a schema.
 */
export class ProviderSource extends Schema.Class<ProviderSource>("ProviderSource")({
  externalId: Schema.String,
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  /** `null` when the provider does not give it before playback */
  durationMs: Schema.NullOr(Schema.Finite),
  /** Matching evidence. The core normalizes it and ignores a value that is not a valid ISRC. */
  isrc: Schema.NullOr(Schema.String),
  /** FFmpeg name of the container that the resolver gives, for example `mov` for MP4 */
  container: Schema.String,
  /** FFmpeg name of the codec, for example `aac` */
  codec: Schema.String,
  lossless: Schema.Boolean,
  encrypted: Schema.Boolean,
  /**
   * Cover image of 500 pixels or more. Clients load it from the provider's server. Cache rows from
   * before artwork existed have no key.
   */
  artworkUrl: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
  ),
  /** Artists of `artist` with provider IDs. The core never identifies an artist by name alone */
  artists: Schema.Array(CreditedArtist).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  /** `null` when the provider does not say */
  explicit: Schema.NullOr(Schema.Boolean).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** In bit/s, `null` when unknown. Downloads keep a lossy source that is not above their target. */
  bitrate: Schema.NullOr(Schema.Int).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /**
   * The account that uploaded the source, for providers with `uploads`. `artist` repeats its name
   * when the uploader typed no other artist.
   */
  uploader: Schema.NullOr(CreditedArtist).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
  /** The `externalId` of the provider's release, for `Provider.album` */
  albumId: Schema.NullOr(Schema.String).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

/** One release on a provider page. The core caches pages on its replica, so they are schemas. */
export class ProviderRelease extends Schema.Class<ProviderRelease>("ProviderRelease")({
  externalId: Schema.String,
  title: Schema.String,
  artist: Schema.NullOr(Schema.String),
  /** The `externalId` for `Provider.artist` */
  artistId: Schema.NullOr(Schema.String),
  releaseDate: Schema.NullOr(PartialDate),
  /** `null` when the provider does not classify it, which is not the same as an album */
  primaryType: Schema.NullOr(ReleaseType),
  secondaryTypes: Schema.Array(SecondaryType),
  explicit: Schema.Boolean,
  trackCount: Schema.NullOr(Schema.Int),
  artworkUrl: Schema.NullOr(Schema.String),
}) {}

export class ProviderTrack extends Schema.Class<ProviderTrack>("ProviderTrack")({
  disc: Schema.NullOr(Schema.Int),
  number: Schema.NullOr(Schema.Int),
  source: ProviderSource,
  /** `false` when the provider does not stream it, for example outside the storefront */
  streamable: Schema.Boolean,
}) {}

export class ProviderAlbum extends Schema.Class<ProviderAlbum>("ProviderAlbum")({
  release: ProviderRelease,
  tracks: Schema.Array(ProviderTrack),
}) {}

export class ProviderArtistCard extends Schema.Class<ProviderArtistCard>("ProviderArtistCard")({
  externalId: Schema.String,
  name: Schema.String,
  artworkUrl: Schema.NullOr(Schema.String),
}) {}

/** A provider gives empty lists for what it does not have */
export class ProviderArtist extends Schema.Class<ProviderArtist>("ProviderArtist")({
  artist: ProviderArtistCard,
  topTracks: Schema.Array(ProviderTrack),
  /** For example the latest uploads */
  tracks: Schema.Array(ProviderTrack),
  /** The artist's own releases. The core puts them into sections by type. */
  releases: Schema.Array(ProviderRelease),
  appearsOn: Schema.Array(ProviderRelease),
  similar: Schema.Array(ProviderArtistCard),
}) {}

/** The core logs `reason`, so it must not contain tokens, signed URLs or keys */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly reason: string;
}> {}

/** Audio bytes of a provider source, in the container and codec of its `ProviderSource` */
export class ProviderAudio extends Data.Class<{
  /** FFmpeg reads the bytes in sequence, so the container must not need seeks */
  readonly bytes: Stream.Stream<Uint8Array, ProviderError>;
  /**
   * `bytes` without the segments that end before `startMs`, for a fast start. Packets keep their
   * timestamps in the source, like the `tfdt` of fragmented MP4.
   */
  readonly bytesFrom?: (startMs: number) => Stream.Stream<Uint8Array, ProviderError>;
  /** CENC content keys in hex by key ID, for encrypted sources. FFmpeg selects the key per sample. */
  readonly decryptionKeys?: Redacted.Redacted<ReadonlyMap<string, string>>;
}> {}

/** One line of a tracklist, as the provider shows it */
export class TracklistEntry extends Schema.Class<TracklistEntry>("TracklistEntry")({
  /** `null` when the line has no time */
  startMs: Schema.NullOr(Schema.Int),
  /** `null` when the line does not separate artist and title */
  artist: Schema.NullOr(Schema.String),
  title: Schema.String,
}) {}

/** One tracklist candidate of a source, for example from the chapters of a video */
export class ProviderTracklist extends Data.Class<{
  /** The core adds it to the origin ref after `#`, for example `chapters` or `comment:<id>` */
  readonly part: string;
  readonly entries: ReadonlyArray<TracklistEntry>;
}> {}

/** Secrets of one linked account, by name. For a browser login, the names are the cookie names. */
export type Credentials = ReadonlyMap<string, Redacted.Redacted<string>>;

/**
 * The core logs and shows `reason`, so it must not contain tokens, signed URLs or keys.
 * `account`: the user must link the account again. `throttled`: the provider wants fewer requests.
 */
export class LibraryError extends Data.TaggedError("LibraryError")<{
  readonly kind: "account" | "throttled" | "failed";
  readonly reason: string;
  /** From the provider's `Retry-After`, for `throttled` only */
  readonly retryAfterSeconds: number | null;
}> {}

/** A cheap check of the user's library songs, so that the core reads them only after a change */
export class LibraryProbe extends Data.Class<{
  /** Changes when songs are added or removed. It is a hint: some changes can keep the same value. */
  readonly version: string;
  readonly total: number | null;
}> {}

export class LibrarySnapshot<A> extends Data.Class<{
  readonly items: ReadonlyArray<A>;
  /** `null` when the read is complete. The core removes nothing after an incomplete read. */
  readonly incompleteReason: string | null;
}> {}

export class LibrarySong extends Data.Class<{
  /** A later write needs it to remove the song */
  readonly remoteId: string;
  /**
   * `null` for a song that is only in the user's library, for example an upload. The core then
   * identifies the song by `remoteId`, so a remote ID must never be equal to a catalog ID.
   */
  readonly catalogId: string | null;
  /** `null` when the user cannot play the song, for example when the storefront does not have it */
  readonly source: ProviderSource | null;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
}> {}

export class LibraryPlaylist extends Data.Class<{
  readonly remoteId: string;
  readonly name: string;
  /** Changes when the playlist changes. `null` if unknown: then the core reads the songs each time. */
  readonly version: string | null;
}> {}

/**
 * The library of a linked account, which the core reads in the background. The core does not
 * pace the calls: the plugin keeps its requests within the provider's limits.
 */
export class ProviderLibrary extends Data.Class<{
  readonly probe: (credentials: Credentials) => Effect.Effect<LibraryProbe, LibraryError>;
  readonly songs: (
    credentials: Credentials,
  ) => Effect.Effect<LibrarySnapshot<LibrarySong>, LibraryError>;
  readonly playlists: (
    credentials: Credentials,
  ) => Effect.Effect<LibrarySnapshot<LibraryPlaylist>, LibraryError>;
  /** In playlist order. A song can be in the list more than once. */
  readonly playlistSongs: (
    credentials: Credentials,
    remoteId: string,
  ) => Effect.Effect<LibrarySnapshot<LibrarySong>, LibraryError>;
}> {}

/**
 * A streaming service. The core calls each function with the credentials of the user who plays or
 * searches. Without `account`, the credentials are empty.
 */
export class Provider extends Data.Class<{
  /** Name to show, for example `Apple Music` */
  readonly name: string;
  /** Called each time that a client starts a stream */
  readonly resolve: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<ProviderAudio, ProviderError>;
  /**
   * Gives the `decryptionKeys` of `resolve` without the audio, for encrypted audio that the core
   * cached. The core caches encrypted audio only from providers that have it.
   */
  readonly keys?: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<Redacted.Redacted<ReadonlyMap<string, string>>, ProviderError>;
  /**
   * Results in the provider's order of relevance, which the core uses when it has no popularity.
   * The core stops waiting after 8 seconds, token refreshes and retries included.
   */
  readonly search?: (
    query: string,
    credentials: Credentials,
  ) => Effect.Effect<ReadonlyArray<ProviderSource>, ProviderError>;
  /**
   * The page of `ProviderSource.artists[0]` or of its `uploader`. The core caches pages on its
   * replica for a day and stops waiting after 20 seconds.
   */
  readonly artist?: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<ProviderArtist, ProviderError>;
  /** The page of `ProviderSource.albumId`, cached like `artist` */
  readonly album?: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<ProviderAlbum, ProviderError>;
  /** Users must link an account before they can search or play the provider */
  readonly account?: {
    readonly login: BrowserLogin;
    /** Checks the credentials with the provider and returns the account name to show */
    readonly link: (credentials: Credentials) => Effect.Effect<string, AccountLinkFailed>;
  };
  /** Only for providers with `account` */
  readonly library?: ProviderLibrary;
  /** Higher wins when providers share a recording. Curated catalogs rank above uploads */
  readonly metadataPriority?: number;
  /**
   * Uploaders type the titles and artists as free text, so the core parses them and does not use
   * them as credits. `ProviderSource.uploader` names the account.
   */
  readonly uploads?: true;
  /** The tracklists that the provider shows for a source, for example of a DJ set */
  readonly tracklists?: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<ReadonlyArray<ProviderTracklist>, ProviderError>;
  /**
   * Lets devices keep files of the provider's audio. A device deletes them when it does not check
   * in with the server for `leaseDays` (`null`: never). Without it, devices cannot download.
   */
  readonly download?: { readonly leaseDays: number | null };
}> {}

export class MusicBrainzRecording extends Data.Class<{
  readonly mbid: string;
  readonly title: string;
  /** The credit as one text, for example `A feat. B` */
  readonly artist: string | null;
  /** With artist MBIDs */
  readonly artists: ReadonlyArray<CreditedArtist>;
  readonly durationMs: number | null;
}> {}

/**
 * `retryAfterSeconds` is set when MusicBrainz throttles. The core waits at least a minute,
 * because MusicBrainz can send 0.
 */
export class MusicBrainzError extends Data.TaggedError("MusicBrainzError")<{
  readonly reason: string;
  readonly retryAfterSeconds: number | null;
}> {}

/** The plugin paces its requests within the MusicBrainz limit */
export class MusicBrainzLookup extends Data.Class<{
  /** The recordings that have each ISRC now. The result has an entry for each valid ISRC. */
  readonly recordingsByIsrc: (
    isrcs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<MusicBrainzRecording>>, MusicBrainzError>;
}> {}

/** Popularity of one recording, for search ranking */
export class PopularityHit extends Data.Class<{
  readonly title: string;
  readonly artist: string;
  readonly isrc: string | null;
  /** From 0 to 1 */
  readonly popularity: number;
}> {}

/** The core logs `reason`, so it must not contain secrets or stream URLs */
export class OutputError extends Data.TaggedError("OutputError")<{
  readonly reason: string;
}> {}

export class OutputInfo extends Data.Class<{
  /** Stable for the device, for example the UPnP UDN */
  readonly id: string;
  readonly name: string;
}> {}

export class UrlStatus extends Data.Class<{
  readonly state: "stopped" | "buffering" | "playing" | "paused";
  /** The URL that the device has loaded, also when another controller loaded it */
  readonly url: string | null;
  /** Position in the stream at `url` */
  readonly positionMs: number;
  /** From 0 to 1 */
  readonly volume: number | null;
  readonly muted: boolean;
}> {}

export class UrlMedia extends Data.Class<{
  readonly url: string;
  readonly contentType: string;
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly artworkUrl: string | null;
  /** Length of the stream at `url` */
  readonly durationMs: number | null;
}> {}

/** A device that pulls a stream URL from the server, for example a Sonos speaker */
export class UrlOutput extends Data.Class<{
  /** The formats that the device decodes. The core selects one for each stream. */
  readonly formats: NonEmptyReadonlyArray<AudioFormat>;
  /** Local address of the connection to the device. The device opens stream URLs at this address. */
  readonly localAddress: string;
  /** Replaces the current item and plays it */
  readonly load: (media: UrlMedia) => Effect.Effect<void, OutputError>;
  readonly play: Effect.Effect<void, OutputError>;
  readonly pause: Effect.Effect<void, OutputError>;
  readonly stop: Effect.Effect<void, OutputError>;
  /** `volume` is from 0 to 1. A muted device unmutes. */
  readonly setVolume: (volume: number) => Effect.Effect<void, OutputError>;
  /**
   * The current status first, then each change, and at least every 5 seconds while it plays. Fails
   * when the device does not answer.
   */
  readonly status: Stream.Stream<UrlStatus, OutputError>;
}> {}

/** Devices of one protocol that pull stream URLs, for example UPnP renderers */
export class UrlOutputs extends Data.Class<{
  /** The current devices, again after each change */
  readonly discover: Stream.Stream<ReadonlyArray<OutputInfo>>;
  /** Opens a device of the last `discover` list until the scope closes */
  readonly open: (id: string) => Effect.Effect<UrlOutput, OutputError, Scope.Scope>;
}> {}

/** What a timed output shows for the entry that plays */
export class TimedMedia extends Data.Class<{
  readonly title: string | null;
  readonly artist: string | null;
  readonly album: string | null;
  readonly artworkUrl: string | null;
  /** Server time in µs at which position 0 of the entry plays, also when it started later */
  readonly startAtUs: number;
  readonly durationMs: number | null;
}> {}

/**
 * A device that plays PCM at set times, for example an AirPlay receiver. Server time is
 * `Clock.monotonicTimeNanos` in µs.
 */
export class TimedOutput extends Data.Class<{
  /** How long before its play time a block must arrive */
  readonly leadMs: number;
  /**
   * Queues interleaved 44.1 kHz stereo PCM whose first frame plays at `playAtUs`. Each block
   * continues the last one; the core calls `flush` before a block that does not.
   */
  readonly write: (playAtUs: number, pcm: Float32Array) => Effect.Effect<void, OutputError>;
  /** Drops all audio that is not played yet */
  readonly flush: Effect.Effect<void, OutputError>;
  /** `volume` is from 0 to 1 */
  readonly setVolume: (volume: number) => Effect.Effect<void, OutputError>;
  readonly setMedia: (media: TimedMedia) => Effect.Effect<void, OutputError>;
  /** Fails when the device goes away or takes another sender */
  readonly closed: Effect.Effect<void, OutputError>;
}> {}

/** Devices of one protocol that play PCM at set times */
export class TimedOutputs extends Data.Class<{
  /** The current devices, again after each change */
  readonly discover: Stream.Stream<ReadonlyArray<OutputInfo>>;
  /** Opens a device of the last `discover` list until the scope closes */
  readonly open: (id: string) => Effect.Effect<TimedOutput, OutputError, Scope.Scope>;
}> {}

export class PluginContext extends Data.Class<{
  readonly library: {
    /**
     * Makes `paths` the audio files of the library folder `root`. The core reads new and changed
     * files and forgets missing ones. A file that it cannot read is logged and skipped.
     */
    readonly sync: (root: string, paths: ReadonlyArray<string>) => Effect.Effect<void>;
  };
  readonly provider: {
    /**
     * `id` is part of every source ID of the provider, so it must never change. Setup fails if
     * another plugin added the same ID, or if it is `library`, `catalog` or `local`.
     */
    readonly add: (id: string, provider: Provider) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly popularity: {
    /**
     * For search ranking. The core matches hits to results by ISRC, else by title and artist, and
     * uses the highest value of all sources. Setup fails if another plugin added the same name.
     */
    readonly add: (
      name: string,
      popularity: (query: string) => Effect.Effect<ReadonlyArray<PopularityHit>, ProviderError>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly musicbrainz: {
    /** Supplies the MusicBrainz lookups of matching. Setup fails if another plugin supplied them. */
    readonly add: (lookup: MusicBrainzLookup) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly outputs: {
    /**
     * Adds the outputs of one protocol. `id` prefixes each output ID, so it must never change; it
     * must be unique, not `device`, and without `:`.
     */
    readonly add: (id: string, outputs: UrlOutputs) => Effect.Effect<void, never, Scope.Scope>;
    /**
     * Adds the timed outputs of one protocol, with the same ID rules as `add`. Optional until the
     * core registers timed outputs.
     */
    readonly addTimed?: (
      id: string,
      outputs: TimedOutputs,
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
}> {}

export class Plugin extends Data.Class<{
  readonly id: string;
  /**
   * Registers what the plugin adds. The `HttpClient` sends the Dyad `User-Agent` and times out
   * after 30 seconds without a response.
   */
  readonly setup: (
    context: PluginContext,
  ) => Effect.Effect<
    void,
    never,
    Scope.Scope | FileSystem.FileSystem | Path.Path | HttpClient.HttpClient
  >;
}> {}
