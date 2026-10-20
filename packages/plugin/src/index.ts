import { PartialDate, ReleaseType, SecondaryType } from "@dyad/domain";
import type { AccountLinkFailed, AudioFormat, BrowserLogin, TokenLogin } from "@dyad/domain";
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
  /** The source has a moving picture for `Provider.video`, not only a still cover */
  video: Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(false)),
    Schema.withConstructorDefault(Effect.succeed(false)),
  ),
  /**
   * The type of the release of `album`. The core shows an album before an EP and a single when a
   * recording is on several. `null` when the provider does not say.
   */
  albumType: Schema.NullOr(ReleaseType).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  /** Sessions count as `live` */
  albumSecondaryTypes: Schema.Array(SecondaryType).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
    Schema.withConstructorDefault(Effect.succeed([])),
  ),
  /** Of the release of `album`. The core shows the earlier edition when a recording is on several. */
  releaseDate: Schema.NullOr(PartialDate).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
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
  /** Same UPC, same edition. Cache rows from before it existed have no key. */
  upc: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
  label: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
}) {}

export class ProviderTrack extends Schema.Class<ProviderTrack>("ProviderTrack")({
  disc: Schema.NullOr(Schema.Int),
  number: Schema.NullOr(Schema.Int),
  source: ProviderSource,
  /** `false` when the provider does not stream it, for example outside the storefront */
  streamable: Schema.Boolean,
  /**
   * The provider of `source` when it is another one, for example a SoundCloud track on a Hype
   * Machine chart. The core keeps a cached copy of that provider, which has more data.
   */
  provider: Schema.NullOr(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(null)),
    Schema.withConstructorDefault(Effect.succeed(null)),
  ),
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

/** The answer of a search. A provider gives empty lists for what it does not search. */
export class ProviderSearch extends Data.Class<{
  /** In the provider's order of relevance, like the other lists */
  readonly songs: ReadonlyArray<ProviderSource>;
  readonly releases: ReadonlyArray<ProviderRelease>;
  readonly artists: ReadonlyArray<ProviderArtistCard>;
}> {}

/** One list of the home page, for example a chart */
export class ProviderShelf extends Schema.Class<ProviderShelf>("ProviderShelf")({
  /** The heading, for example `Top songs` */
  title: Schema.String,
  tracks: Schema.Array(ProviderTrack),
  releases: Schema.Array(ProviderRelease),
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

/** VP9 video in WebM with `Cues`, without audio, on the timeline of the source's audio */
export class ProviderVideo extends Data.Class<{
  readonly bytes: Stream.Stream<Uint8Array, ProviderError>;
  /** The WebM head, then the clusters from the cue at or before `startMs` */
  readonly bytesFrom: (startMs: number) => Stream.Stream<Uint8Array, ProviderError>;
}> {}

/**
 * A source of another provider that plays in place of a source, for a provider without its own
 * audio. It must have the container and codec of the source that links to it.
 */
export class ProviderLink extends Data.TaggedClass("ProviderLink")<{
  readonly provider: string;
  readonly externalId: string;
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
  /**
   * From 0 to 1, for the selection among the candidates of a source: 1 for structured platform
   * data, 0.9 for chapters, 0.8 for a description, 0.7 for a tracklist site, 0.6 for a comment,
   * 0.5 for a list without times
   */
  readonly confidence: number;
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
  /** The user's mark on the provider, from `songs` only. Without it, the song is saved. */
  readonly mark?: "favorite" | "disliked" | undefined;
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
 * Writes to the playlists of a linked account, for playlists with a two-way link. Songs are
 * `ProviderSource.externalId` values. The core sends the edits that the provider can make and shows
 * the playlist as different from the provider for the others.
 */
export class ProviderPlaylists extends Data.Class<{
  /** Returns the `LibraryPlaylist.remoteId` of the new, empty playlist */
  readonly create?: (credentials: Credentials, name: string) => Effect.Effect<string, LibraryError>;
  /** Adds the songs at the end */
  readonly add?: (
    credentials: Credentials,
    remoteId: string,
    songs: ReadonlyArray<string>,
  ) => Effect.Effect<void, LibraryError>;
}> {}

/**
 * Writes the owner's song marks to the library of a linked account. Songs are
 * `ProviderSource.externalId` values. The core sends saves and favorites once, after each change.
 * It does not remove songs from the library: removals stay in Dyad.
 */
export class ProviderMarks extends Data.Class<{
  /** Adds the songs to the library */
  readonly save?: (
    credentials: Credentials,
    songs: ReadonlyArray<string>,
  ) => Effect.Effect<void, LibraryError>;
  /** Adds the songs to the favorites, or removes them from the favorites */
  readonly favorite?: (
    credentials: Credentials,
    songs: ReadonlyArray<string>,
    favorite: boolean,
  ) => Effect.Effect<void, LibraryError>;
}> {}

/**
 * A streaming service. The core calls each function with the credentials of the linked account.
 * Without `account`, the credentials are empty.
 */
export class Provider extends Data.Class<{
  /** Name to show, for example `Apple Music` */
  readonly name: string;
  /** Called each time that a client starts a stream */
  readonly resolve: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<ProviderAudio | ProviderLink, ProviderError>;
  /**
   * Gives the `decryptionKeys` of `resolve` without the audio, for encrypted audio that the core
   * cached. The core caches encrypted audio only from providers that have it.
   */
  readonly keys?: (
    externalId: string,
    credentials: Credentials,
  ) => Effect.Effect<Redacted.Redacted<ReadonlyMap<string, string>>, ProviderError>;
  /**
   * The video of a source with `ProviderSource.video`: the tallest stream that is at most
   * `maxHeight` pixels high, else the smallest
   */
  readonly video?: (
    externalId: string,
    credentials: Credentials,
    maxHeight: number,
  ) => Effect.Effect<ProviderVideo, ProviderError>;
  /**
   * Results in the provider's order of relevance, which the core uses when it has no popularity.
   * The core stops waiting after 8 seconds, token refreshes and retries included.
   */
  readonly search?: (
    query: string,
    credentials: Credentials,
  ) => Effect.Effect<ProviderSearch, ProviderError>;
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
  /**
   * Shelves for the home page, cached like `artist`. Use `Recommender` for personal shelves.
   */
  readonly home?: (
    credentials: Credentials,
  ) => Effect.Effect<ReadonlyArray<ProviderShelf>, ProviderError>;
  /** Without `optional`, the owner must link an account to search or play the provider */
  readonly account?: {
    /** With a `TokenLogin`, the credentials have one value, `token` */
    readonly login: BrowserLogin | TokenLogin;
    /** The provider can also search and play without an account */
    readonly optional?: true;
    /** Checks the credentials with the provider and returns the account name to show */
    readonly link: (credentials: Credentials) => Effect.Effect<string, AccountLinkFailed>;
  };
  /** Only for providers with `account` */
  readonly library?: ProviderLibrary;
  /** Only for providers with `library`, which reads the playlists */
  readonly playlists?: ProviderPlaylists;
  /** Only for providers with `library`, whose import reads the marks back */
  readonly marks?: ProviderMarks;
  /** Which of its facts win over the facts of other plugins */
  readonly factRank?: FactRank;
  /**
   * Uploaders type the titles and artists as free text, so the core parses them and does not use
   * them as credits. `ProviderSource.uploader` names the account.
   */
  readonly uploads?: true;
  /**
   * The core asks the provider only for what the user opens, never in the background, because
   * background requests risk a block of the account or the address
   */
  readonly userRequestsOnly?: true;
  /**
   * The provider has no audio of its own: `resolve` gives a `ProviderLink`. The core plays the other
   * sources of the same recording first.
   */
  readonly links?: true;
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
  /** The page of a source on the provider's site, without a request. `null` when the ID gives none. */
  readonly webUrl?: (externalId: string) => string | null;
  /**
   * The ID of the artist whose page `url` is, for example from a MusicBrainz URL relation. `null`
   * for a URL of another site. A plugin sends no request for a URL of another site.
   */
  readonly artistFromUrl?: (url: string) => Effect.Effect<string | null, ProviderError>;
}> {}

/** A song that a recommender suggests. The core finds a playable source for it. */
export class Suggestion extends Schema.Class<Suggestion>("Suggestion")({
  title: Schema.String,
  artist: Schema.String,
  /** A source of the provider with the recommender's ID. Without it, the core looks for one. */
  source: Schema.NullOr(ProviderSource),
}) {}

/** One personal list, for example `Quick picks`. The core caches it, so it is a schema. */
export class SuggestionShelf extends Schema.Class<SuggestionShelf>("SuggestionShelf")({
  title: Schema.String,
  songs: Schema.Array(Suggestion),
  /** Releases of the provider with the recommender's ID */
  releases: Schema.Array(ProviderRelease),
}) {}

/** The song or artist that a radio starts from */
export class RadioSeed extends Data.Class<{
  /** `null` for an artist */
  readonly title: string | null;
  readonly artist: string;
  /** The `ProviderSource.externalId` when the seed is a source of the recommender's provider */
  readonly externalId: string | null;
}> {}

/** One play that the user listened to */
export class Scrobble extends Data.Class<{
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly durationMs: number | null;
  /** Epoch milliseconds */
  readonly startedAt: number;
}> {}

/**
 * Personal suggestions of a service, for example YouTube Music or ListenBrainz. The functions get
 * the credentials of the account of the provider with the recommender's ID, else of the
 * recommender's own `account`.
 */
export class Recommender extends Data.Class<{
  readonly name: string;
  /** Higher first when the core merges the suggestions of several recommenders */
  readonly priority?: number;
  /** Only when no provider has the recommender's ID */
  readonly account?: Provider["account"];
  /** Called only with a linked account. The core caches the shelves for 6 hours. */
  readonly shelves?: (
    credentials: Credentials,
  ) => Effect.Effect<ReadonlyArray<SuggestionShelf>, ProviderError>;
  /** Songs that follow the seed, best first. The credentials are empty without a linked account. */
  readonly radio?: (
    seed: RadioSeed,
    credentials: Credentials,
  ) => Effect.Effect<ReadonlyArray<Suggestion>, ProviderError>;
  /** Sends plays to the account. Called only with a linked account, at most 100 plays at a time. */
  readonly scrobble?: (
    plays: ReadonlyArray<Scrobble>,
    credentials: Credentials,
  ) => Effect.Effect<void, LibraryError>;
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
/** The rank of a plugin's facts against the facts of other plugins. Higher wins; a missing rank is 0. */
export class FactRank extends Data.Class<{
  /** Fields without their own rank: titles, artists, artwork, durations */
  readonly metadata?: number;
  readonly type?: number;
  /** Also the catalog number */
  readonly label?: number;
}> {}

export class MusicBrainzLookup extends Data.Class<{
  readonly factRank: FactRank;
  /** The recordings that have each ISRC now. The result has an entry for each valid ISRC. */
  readonly recordingsByIsrc: (
    isrcs: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<MusicBrainzRecording>>, MusicBrainzError>;
  /**
   * Candidate recordings of each free-text artist and title, by `key`, best first. The core checks
   * that a candidate fits, so an item without a good match can have none or wrong ones.
   */
  readonly recordingsByText: (
    items: ReadonlyArray<{ readonly key: string; readonly artist: string; readonly title: string }>,
  ) => Effect.Effect<ReadonlyMap<string, ReadonlyArray<MusicBrainzRecording>>, MusicBrainzError>;
  /** The URLs of the current URL relations of an artist. Empty when MusicBrainz has no such artist. */
  readonly artistUrls: (mbid: string) => Effect.Effect<ReadonlyArray<string>, MusicBrainzError>;
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
  /** IP address. Outputs of two plugins on one address show as one row of the device. */
  readonly host?: string | undefined;
  /** URL outputs of one plugin with the same value can play in sync through `UrlOutputs.join` */
  readonly nativeGroup?: string | undefined;
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
  /** Replaces the current item and plays it. The device forgets the next item. */
  readonly load: (media: UrlMedia) => Effect.Effect<void, OutputError>;
  /**
   * Sets the item that the device plays without a gap after the current one, or removes it with
   * `null`. When it starts, `status.url` changes to its URL.
   */
  readonly loadNext?: (media: UrlMedia | null) => Effect.Effect<void, OutputError>;
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
  /**
   * The device plays a FLAC stream without an end, so that the server can render crossfades and DJ
   * transitions for it
   */
  readonly live?: boolean;
}> {}

/** A device that plays what another device plays, in sync, until the scope closes */
export class UrlMember extends Data.Class<{
  /** `volume` is from 0 to 1. A muted device unmutes. */
  readonly setVolume: (volume: number) => Effect.Effect<void, OutputError>;
  /** Completes when another controller takes the device out of the group */
  readonly left: Effect.Effect<void>;
}> {}

/** Devices of one protocol that pull stream URLs, for example UPnP renderers */
export class UrlOutputs extends Data.Class<{
  /** The current devices, again after each change */
  readonly discover: Stream.Stream<ReadonlyArray<OutputInfo>>;
  /** Opens a device of the last `discover` list until the scope closes */
  readonly open: (id: string) => Effect.Effect<UrlOutput, OutputError, Scope.Scope>;
  /**
   * Makes device `id` play what device `coordinator` plays, until the scope closes. Both have the
   * same `OutputInfo.nativeGroup`.
   */
  readonly join?: (
    id: string,
    coordinator: string,
  ) => Effect.Effect<UrlMember, OutputError, Scope.Scope>;
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
  readonly recommenders: {
    /** Setup fails if another plugin added the same ID */
    readonly add: (id: string, recommender: Recommender) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly musicbrainz: {
    /** Supplies the MusicBrainz lookups of matching. Setup fails if another plugin supplied them. */
    readonly add: (lookup: MusicBrainzLookup) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly tracklists: {
    /**
     * Tracklists of sets from a site that does not host them. The origin ref is `<id>:<part>`, so
     * `id` is not a provider ID and `part` names the page, for example `<page_id>#tracklist`.
     */
    readonly add: (
      id: string,
      lookup: (set: {
        /** As the core parsed them from the title of the upload */
        readonly artists: ReadonlyArray<string>;
        /** The title of the upload, for example `Fred again.. | Boiler Room: London` */
        readonly title: string;
        readonly durationMs: number | null;
      }) => Effect.Effect<ReadonlyArray<ProviderTracklist>, ProviderError>,
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly outputs: {
    /**
     * Adds the outputs of one protocol. `id` prefixes each output ID, so it must never change; it
     * must be unique, not `device`, and without `:`.
     */
    readonly add: (id: string, outputs: UrlOutputs) => Effect.Effect<void, never, Scope.Scope>;
    /** Adds the timed outputs of one protocol, with the same ID rules as `add` */
    readonly addTimed: (
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
