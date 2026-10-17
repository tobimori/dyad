import { Data } from "effect";
import type { Effect, FileSystem, Path, Scope } from "effect";

/** Domains such as `provider` are added when the first plugin needs them */
export class PluginContext extends Data.Class<{
  readonly library: {
    /**
     * Makes `paths` the audio files of the library folder `root`. The core reads new and changed
     * files and forgets missing ones. A file that it cannot read is logged and skipped.
     */
    readonly sync: (root: string, paths: ReadonlyArray<string>) => Effect.Effect<void>;
  };
}> {}

export class Plugin extends Data.Class<{
  readonly id: string;
  /** Registers what the plugin adds. Closing the plugin scope removes the registrations. */
  readonly setup: (
    context: PluginContext,
  ) => Effect.Effect<void, never, Scope.Scope | FileSystem.FileSystem | Path.Path>;
}> {}
