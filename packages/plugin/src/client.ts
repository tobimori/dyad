import type { SourceSummary } from "@dyad/domain";
import { Data } from "effect";
import type { Effect, Scope, Stream } from "effect";

/** The source that this device plays or has paused */
export class NowPlaying extends Data.Class<{
  readonly source: SourceSummary;
  readonly state: "playing" | "paused";
  /** Position in the source at the time `at` */
  readonly positionMs: number;
  /** Unix time in milliseconds */
  readonly at: number;
  /** `null` while the client does not know it, for example for Bandcamp before the download ends */
  readonly durationMs: number | null;
}> {}

export class ClientPluginContext extends Data.Class<{
  /** Origin of the Dyad server. Its URLs are private to the workspace. */
  readonly serverOrigin: string;
  readonly playback: {
    /** The current value, then each change. `null` when nothing is loaded. */
    readonly nowPlaying: Stream.Stream<NowPlaying | null>;
  };
}> {}

/**
 * Runs in the CLI or the Electron main process, not on the web, because browsers cannot open local
 * sockets. It runs only after the user turns it on for the device.
 */
export class ClientPlugin extends Data.Class<{
  readonly id: string;
  readonly name: string;
  /** The client shows it when the user turns the plugin on */
  readonly notice: string;
  /** Starts the work in the scope and returns. Turning the plugin off closes the scope. */
  readonly setup: (context: ClientPluginContext) => Effect.Effect<void, never, Scope.Scope>;
}> {}
