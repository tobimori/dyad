import { PluginContext } from "@dyad/plugin";
import type { Plugin } from "@dyad/plugin";
import { Effect, Exit, Layer, Scope } from "effect";

/** Starts each plugin in its own scope. If setup fails, only that plugin stops. */
export const pluginLayer = (plugins: ReadonlyArray<Plugin>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      yield* Effect.forEach(
        plugins,
        (plugin) =>
          Effect.gen(function* () {
            const pluginScope = yield* Scope.fork(scope);
            const exit = yield* plugin
              .setup(new PluginContext())
              .pipe(Scope.provide(pluginScope), Effect.exit);
            if (Exit.isSuccess(exit)) return;
            yield* Scope.close(pluginScope, exit);
            yield* Effect.logError("Plugin setup failed", exit.cause).pipe(
              Effect.annotateLogs("pluginId", plugin.id),
            );
          }),
        { discard: true },
      );
    }),
  );
