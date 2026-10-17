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
  readonly durationMs: number;
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
    /** Adds or updates a provider source in the catalog */
    readonly add: (source: ProviderSource) => Effect.Effect<void>;
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
