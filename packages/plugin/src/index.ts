import type { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import { Data } from "effect";
import type { Effect, FileSystem, Path, Redacted, Scope, Stream } from "effect";

/** A playable item of a provider, for example one Apple Music song */
export class ProviderSource extends Data.Class<{
  /** Provider name in the catalog, for example `apple_music` */
  readonly provider: string;
  readonly externalId: string;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  /** `null` when the provider does not give it before playback */
  readonly durationMs: number | null;
  /** Links the source to the same recording from other providers and local files */
  readonly isrc: string | null;
  /** FFmpeg name of the container that the resolver gives, for example `mov` for MP4 */
  readonly container: string;
  /** FFmpeg name of the codec, for example `aac` */
  readonly codec: string;
  readonly lossless: boolean;
  readonly encrypted: boolean;
}> {}

/** Audio bytes of a provider source, in the container and codec of its `ProviderSource` */
export class ProviderAudio extends Data.Class<{
  /** FFmpeg reads the bytes in sequence, so the container must not need seeks */
  readonly bytes: Stream.Stream<Uint8Array, ResolveError>;
  /** CENC content keys in hex by key ID, for encrypted sources. FFmpeg selects the key per sample. */
  readonly decryptionKeys?: Redacted.Redacted<ReadonlyMap<string, string>>;
}> {}

export type Resolve = (
  externalId: string,
  credentials: Credentials,
) => Effect.Effect<ProviderAudio, ResolveError>;

/**
 * Searches the provider's catalog with the credentials of the user who searches. The results are in
 * the provider's order of relevance; the core uses that order when it has no popularity.
 */
export type Search = (
  query: string,
  credentials: Credentials,
) => Effect.Effect<ReadonlyArray<ProviderSource>, SearchError>;

/** Popularity of one recording, for search ranking */
export class PopularityHit extends Data.Class<{
  readonly title: string;
  readonly artist: string;
  readonly isrc: string | null;
  /** From 0 to 1 */
  readonly popularity: number;
}> {}

/** Popularity of the recordings that match `query` */
export type Popularity = (
  query: string,
) => Effect.Effect<ReadonlyArray<PopularityHit>, SearchError>;

/** The core logs `reason`, so it must not contain tokens, signed URLs or keys */
export class SearchError extends Data.TaggedError("SearchError")<{
  readonly reason: string;
}> {}

/** The core logs `reason`, so it must not contain tokens, signed URLs or keys */
export class ResolveError extends Data.TaggedError("ResolveError")<{
  readonly reason: string;
}> {}

/** Secrets of one linked account, by name. For a browser login, the names are the cookie names. */
export type Credentials = ReadonlyMap<string, Redacted.Redacted<string>>;

export class AccountProvider extends Data.Class<{
  /** Name to show, for example `Apple Music` */
  readonly name: string;
  readonly login: BrowserLogin;
  /** Checks the credentials with the provider and returns the account name to show */
  readonly link: (credentials: Credentials) => Effect.Effect<string, AccountLinkFailed>;
}> {}

/** Domains such as `provider` are added when the first plugin needs them */
export class PluginContext extends Data.Class<{
  readonly library: {
    /**
     * Makes `paths` the audio files of the library folder `root`. The core reads new and changed
     * files and forgets missing ones. A file that it cannot read is logged and skipped.
     */
    readonly sync: (root: string, paths: ReadonlyArray<string>) => Effect.Effect<void>;
  };
  readonly source: {
    /** Adds or updates a provider source in the shared catalog, for example from a library sync */
    readonly add: (source: ProviderSource) => Effect.Effect<void>;
  };
  readonly search: {
    /**
     * Adds the catalog search of `provider` for users who can use the provider. The core caches the
     * results on this replica and adds a result to the shared catalog when it is played.
     */
    readonly add: (provider: string, search: Search) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly popularity: {
    /**
     * Adds a popularity source for search ranking. The core matches hits to results by ISRC, or
     * else by title and artist, and uses the highest value of all sources.
     */
    readonly add: (name: string, popularity: Popularity) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly account: {
    /** Lets users link their account of `provider`. The core stores the credentials. */
    readonly add: (
      provider: string,
      accountProvider: AccountProvider,
    ) => Effect.Effect<void, never, Scope.Scope>;
  };
  readonly resolver: {
    /**
     * Makes the sources of `provider` playable. The core calls `resolve` each time that a client
     * starts a stream, with the credentials of the user who plays.
     */
    readonly add: (provider: string, resolve: Resolve) => Effect.Effect<void, never, Scope.Scope>;
  };
}> {}

export class Plugin extends Data.Class<{
  readonly id: string;
  /** Registers what the plugin adds. Closing the plugin scope removes the registrations. */
  readonly setup: (
    context: PluginContext,
  ) => Effect.Effect<void, never, Scope.Scope | FileSystem.FileSystem | Path.Path>;
}> {}
