import { discordPresencePlugin } from "@dyad/plugin-discord-presence/client";
import type { ClientPlugin, ClientPluginContext } from "@dyad/plugin/client";
import { Data, Effect, Exit, Scope } from "effect";
import type { FileSystem, Path } from "effect";

import { Settings, loadSettings, updateSettings } from "./settings.ts";

// Each plugin is off until the user turns it on for this device
export const clientPlugins: ReadonlyArray<ClientPlugin> = [discordPresencePlugin];

export const withEnabled = (settings: Settings, id: string, enabled: boolean) => {
  const others = settings.enabledPlugins.filter((other) => other !== id);
  return new Settings({ ...settings, enabledPlugins: enabled ? [...others, id] : others });
};

export class PluginHost extends Data.Class<{
  readonly plugins: ReadonlyArray<ClientPlugin>;
  readonly isEnabled: (id: string) => boolean;
  /** Saves the setting, then starts or stops the plugin */
  readonly setEnabled: (id: string, enabled: boolean) => Effect.Effect<void>;
}> {}

/**
 * Starts each enabled plugin in its own scope below the current scope. If setup fails, only that
 * plugin stops. The plugins log with the logger of the effect that starts them.
 */
export const startPluginHost = (context: ClientPluginContext) =>
  Effect.gen(function* () {
    const parent = yield* Effect.scope;
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
    const running = new Map<string, Scope.Closeable>();

    // A broken file must not stop the player. The next change writes a new file.
    let settings = yield* loadSettings.pipe(
      Effect.tapCause((cause) => Effect.logWarning("Cannot read the settings", cause)),
      Effect.orElseSucceed(() => new Settings({ enabledPlugins: [] })),
    );

    const start = (plugin: ClientPlugin) =>
      Effect.gen(function* () {
        if (running.has(plugin.id)) return;

        const scope = yield* Scope.fork(parent);
        const exit = yield* plugin.setup(context).pipe(Scope.provide(scope), Effect.exit);
        if (Exit.isSuccess(exit)) {
          running.set(plugin.id, scope);
          return;
        }

        yield* Scope.close(scope, exit);
        yield* Effect.logError("Plugin setup failed", exit.cause).pipe(
          Effect.annotateLogs("pluginId", plugin.id),
        );
      });

    const stop = (id: string) =>
      Effect.gen(function* () {
        const scope = running.get(id);
        if (scope === undefined) return;

        running.delete(id);
        yield* Scope.close(scope, Exit.void);
      });

    const enabled = clientPlugins.filter((plugin) => settings.enabledPlugins.includes(plugin.id));
    yield* Effect.forEach(enabled, start, { discard: true });

    const setEnabled = (id: string, enable: boolean) =>
      Effect.gen(function* () {
        const plugin = clientPlugins.find((candidate) => candidate.id === id);
        if (plugin === undefined) return;

        settings = withEnabled(settings, id, enable);
        yield* updateSettings((current) => withEnabled(current, id, enable)).pipe(
          Effect.provideContext(services),
          Effect.tapCause((cause) => Effect.logWarning("Cannot save the settings", cause)),
          Effect.ignore,
        );

        if (enable) {
          yield* start(plugin);
          return;
        }
        yield* stop(id);
      });

    return new PluginHost({
      plugins: clientPlugins,
      isEnabled: (id) => settings.enabledPlugins.includes(id),
      setEnabled,
    });
  });
