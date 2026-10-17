import type { Effect, Scope } from "effect";

/** Domains such as `provider` are added when the first plugin needs them */
export interface PluginContext {}

export interface Plugin {
  readonly id: string;
  /** Registers what the plugin adds. Closing the plugin scope removes the registrations. */
  readonly setup: (context: PluginContext) => Effect.Effect<void, never, Scope.Scope>;
}
