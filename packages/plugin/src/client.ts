// The entry point for plugins that run in a client process on the user's device: the CLI now,
// the Electron main process later. Browsers cannot open local sockets, so the web app has none.

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
 * A plugin that runs on one device, only after the user turns it on for that device. Turning it
 * off closes the scope of `setup`.
 */
export class ClientPlugin extends Data.Class<{
  readonly id: string;
  /** Name to show, for example `Discord presence` */
  readonly name: string;
  /** The client shows it when the user turns the plugin on */
  readonly notice: string;
  /** Starts the work of the plugin in the scope and returns. If it fails, only this plugin stops. */
  readonly setup: (context: ClientPluginContext) => Effect.Effect<void, never, Scope.Scope>;
}> {}
