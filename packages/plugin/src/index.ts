import type { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import { Data, Effect, Schema } from "effect";
import type { FileSystem, Path, Redacted, Scope, Stream } from "effect";
import type { HttpClient } from "effect/http";

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
}) {}

/** The core logs `reason`, so it must not contain tokens, signed URLs or keys */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly reason: string;
}> {}

/** Audio bytes of a provider source, in the container and codec of its `ProviderSource` */
export class ProviderAudio extends Data.Class<{
  /** FFmpeg reads the bytes in sequence, so the container must not need seeks */
  readonly bytes: Stream.Stream<Uint8Array, ProviderError>;
  /** CENC content keys in hex by key ID, for encrypted sources. FFmpeg selects the key per sample. */
  readonly decryptionKeys?: Redacted.Redacted<ReadonlyMap<string, string>>;
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
   * Searches the provider's catalog. The results are in the provider's order of relevance; the
   * core uses that order when it has no popularity. The core stops waiting after 8 seconds, token
   * refreshes and retries included.
   */
  readonly search?: (
    query: string,
    credentials: Credentials,
  ) => Effect.Effect<ReadonlyArray<ProviderSource>, ProviderError>;
  /** Users must link an account before they can search or play the provider */
  readonly account?: {
    readonly login: BrowserLogin;
    /** Checks the credentials with the provider and returns the account name to show */
    readonly link: (credentials: Credentials) => Effect.Effect<string, AccountLinkFailed>;
  };
  /** Only for providers with `account` */
  readonly library?: ProviderLibrary;
}> {}

/** Popularity of one recording, for search ranking */
export class PopularityHit extends Data.Class<{
  readonly title: string;
  readonly artist: string;
  readonly isrc: string | null;
  /** From 0 to 1 */
  readonly popularity: number;
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
     * Adds the provider `id`, for example `apple_music`. The ID is part of every source ID of the
     * provider, so it must never change. Setup fails if another plugin added the same ID, or if
     * the ID is `library`, `catalog` or `local`.
     */
    readonly add: (id: string, provider: Provider) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly popularity: {
    /**
     * Adds a popularity source for search ranking. The core matches hits to results by ISRC, or
     * else by title and artist, and uses the highest value of all sources. Setup fails if another
     * plugin added the same name.
     */
    readonly add: (
      name: string,
      popularity: (query: string) => Effect.Effect<ReadonlyArray<PopularityHit>, ProviderError>,
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
