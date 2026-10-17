import type { Database } from "@dyad/db/node";
import { PluginContext } from "@dyad/plugin";
import type { Plugin } from "@dyad/plugin";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Crypto, FileSystem, Path } from "effect";

import { AccountProviders } from "./accounts.ts";
import { addProviderSource, syncLibraryRoot } from "./library.ts";
import { SourceResolvers } from "./playback.ts";

/** Starts each plugin in its own scope. If setup fails, only that plugin stops. */
export const pluginLayer = (plugins: ReadonlyArray<Plugin>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const resolvers = yield* SourceResolvers;
      const accountProviders = yield* AccountProviders;
      const services = yield* Effect.context<
        Database | Crypto.Crypto | FileSystem.FileSystem | Path.Path
      >();
      const context = new PluginContext({
        library: {
          sync: (root, paths) =>
            syncLibraryRoot(root, paths).pipe(
              Effect.catch((error) => Effect.logError("Library sync failed", error)),
              Effect.provide(services),
            ),
        },
        source: {
          add: (providerSource) =>
            addProviderSource(providerSource).pipe(
              Effect.catch((error) => Effect.logError("Cannot add the source", error)),
              Effect.provide(services),
            ),
        },
        account: {
          add: (provider, accountProvider) =>
            Effect.acquireRelease(
              Effect.sync(() => accountProviders.set(provider, accountProvider)),
              () => Effect.sync(() => accountProviders.delete(provider)),
            ).pipe(Effect.asVoid),
        },
        resolver: {
          add: (provider, resolve) =>
            Effect.acquireRelease(
              Effect.sync(() => resolvers.set(provider, resolve)),
              () => Effect.sync(() => resolvers.delete(provider)),
            ).pipe(Effect.asVoid),
        },
      });
      yield* Effect.forEach(
        plugins,
        (plugin) =>
          Effect.gen(function* () {
            const pluginScope = yield* Scope.fork(scope);
            const exit = yield* plugin.setup(context).pipe(Scope.provide(pluginScope), Effect.exit);
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
