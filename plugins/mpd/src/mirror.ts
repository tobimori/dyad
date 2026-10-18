import type {
  PlaylistSummary,
  SessionCommand,
  SessionCommandFailed,
  SessionCommandResult,
  SessionEvent,
  SourceSummary,
} from "@dyad/domain";
import { Context, Data } from "effect";
import type { Effect, Option, Stream } from "effect";

export class Library extends Data.Class<{
  /** The user's library songs that have a source */
  readonly songs: ReadonlyArray<SourceSummary>;
  /** Epoch ms of the last library sync; Cantata reloads its cache when it changes */
  readonly syncedAt: number;
}> {}

export class Artwork extends Data.Class<{
  readonly bytes: Uint8Array;
  readonly mimeType: string;
}> {}

export class MirrorUnavailable extends Data.TaggedError("MirrorUnavailable")<{}> {}

/** One user's Dyad session and library, for one MPD connection */
export class SessionMirror extends Context.Service<
  SessionMirror,
  {
    /** Each run subscribes to the session: a `Snapshot`, then its changes */
    readonly events: Stream.Stream<typeof SessionEvent.Type, MirrorUnavailable>;
    readonly control: (
      command: typeof SessionCommand.Type,
      ifQueueVersion: number | null,
    ) => Effect.Effect<SessionCommandResult, SessionCommandFailed | MirrorUnavailable>;
    /** `update` when a library sync starts or ends, `database` when the library changes */
    readonly libraryChanges: Stream.Stream<"update" | "database">;
    readonly library: Effect.Effect<Library, MirrorUnavailable>;
    /** Searches the library and the catalogs of all providers */
    readonly search: (
      query: string,
    ) => Effect.Effect<ReadonlyArray<SourceSummary>, MirrorUnavailable>;
    /** Starts a library sync of each linked account */
    readonly sync: Effect.Effect<void, MirrorUnavailable>;
    readonly playlists: Effect.Effect<ReadonlyArray<PlaylistSummary>, MirrorUnavailable>;
    readonly playlistSongs: (
      playlistId: string,
    ) => Effect.Effect<ReadonlyArray<SourceSummary>, MirrorUnavailable>;
    readonly artwork: (
      sourceId: string,
    ) => Effect.Effect<Option.Option<Artwork>, MirrorUnavailable>;
  }
>()("@dyad/plugin-mpd/SessionMirror") {}
