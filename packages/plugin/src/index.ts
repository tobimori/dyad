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
