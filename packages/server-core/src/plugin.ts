import type { Database } from "@dyad/db/node";
import { PluginContext } from "@dyad/plugin";
import type { Plugin } from "@dyad/plugin";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Crypto, FileSystem, Path } from "effect";

import { AccountProviders } from "./accounts.ts";
import { addProviderSource, syncLibraryRoot } from "./library.ts";
import { SourceResolvers, SourceSearches } from "./providers.ts";

// Closing the plugin scope removes the registration
const register = <A>(registry: Map<string, A>, provider: string, value: A) =>
  Effect.acquireRelease(
    Effect.sync(() => registry.set(provider, value)),
    () => Effect.sync(() => registry.delete(provider)),
  ).pipe(Effect.asVoid);

/** Starts each plugin in its own scope. If setup fails, only that plugin stops. */
export const pluginLayer = (plugins: ReadonlyArray<Plugin>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const resolvers = yield* SourceResolvers;
      const searches = yield* SourceSearches;
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
        search: {
          add: (provider, search) => register(searches, provider, search),
        },
        account: {
          add: (provider, accountProvider) => register(accountProviders, provider, accountProvider),
        },
        resolver: {
          add: (provider, resolve) => register(resolvers, provider, resolve),
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
