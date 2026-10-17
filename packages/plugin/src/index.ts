import { Data } from "effect";
import type { Effect, Scope } from "effect";

/** Domains such as `provider` are added when the first plugin needs them */
export class PluginContext extends Data.Class {}

export class Plugin extends Data.Class<{
  readonly id: string;
  /** Registers what the plugin adds. Closing the plugin scope removes the registrations. */
  readonly setup: (context: PluginContext) => Effect.Effect<void, never, Scope.Scope>;
}> {}
