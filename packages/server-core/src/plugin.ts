import type { Database, ReplicaDatabase } from "@dyad/db/node";
import { PluginContext } from "@dyad/plugin";
import type { Plugin } from "@dyad/plugin";
import type { HlcClock } from "@dyad/sync";
import { Effect, Exit, Layer, Scope } from "effect";
import type { Crypto, FileSystem, Path } from "effect";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest } from "effect/http";

import type { Jobs } from "./jobs.ts";
import { syncLibraryRoot } from "./library.ts";
import { MusicBrainzLookups, musicbrainzLookupKey } from "./matching.ts";
import { Outputs } from "./outputs.ts";
import { Popularities, Providers } from "./providers.ts";
import { Tracklists } from "./tracklists.ts";

// A second registration of a key would replace the first, and closing either plugin scope would
// remove both. The defect fails the setup of the second plugin only.
const register = <A>(registry: Map<string, A>, key: string, value: A) =>
  Effect.acquireRelease(
    Effect.suspend(() =>
      registry.has(key)
        ? Effect.die(new Error(`"${key}" is already registered by another plugin`))
        : Effect.sync(() => registry.set(key, value)),
    ),
    () => Effect.sync(() => registry.delete(key)),
  ).pipe(Effect.asVoid);

// Page refs will use `library` and `catalog` as namespaces next to the provider IDs. The core writes
// local files with the provider `local`, so a plugin with that ID would mix its sources with them.
const reservedProviderIds = new Set(["library", "catalog", "local"]);

// A request without a response after this time fails. A response body, such as an audio stream,
// has no time limit.
const responseTimeout = "30 seconds";

const pluginHttpClient = (version: string) =>
  Layer.effect(
    HttpClient.HttpClient,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;

      return client.pipe(
        // A plugin can send its own `User-Agent`, for example with the contact URL that MusicBrainz
        // requires
        HttpClient.mapRequest((request) =>
          request.headers["user-agent"] === undefined
            ? HttpClientRequest.setHeader(request, "User-Agent", `Dyad/${version}`)
            : request,
        ),
        HttpClient.transform((response, request) =>
          response.pipe(
            Effect.timeoutOrElse({
              duration: responseTimeout,
              orElse: () =>
                Effect.fail(
                  new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      description: "No response",
                    }),
                  }),
                ),
            }),
            // Spans hold the full URL, and many provider URLs are signed or carry a key
            Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          ),
        ),
      );
    }),
  ).pipe(Layer.provide(FetchHttpClient.layer));

/**
 * Starts each plugin in its own scope. If setup fails, only that plugin stops. `version` goes
 * into the `User-Agent` of plugin requests.
 */
export const pluginLayer = (plugins: ReadonlyArray<Plugin>, version: string) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const providers = yield* Providers;
      const popularities = yield* Popularities;
      const musicbrainzLookups = yield* MusicBrainzLookups;
      const outputs = yield* Outputs;
      const tracklists = yield* Tracklists;
      const services = yield* Effect.context<
        | Database
        | ReplicaDatabase
        | HlcClock
        | Jobs
        | MusicBrainzLookups
        | Providers
        | Crypto.Crypto
        | FileSystem.FileSystem
        | Path.Path
      >();

      const context = new PluginContext({
        library: {
          sync: (root, paths) =>
            syncLibraryRoot(root, paths).pipe(
              Effect.catch((error) => Effect.logError("Library sync failed", error)),
              Effect.provide(services),
            ),
        },
        provider: {
          add: (id, provider) =>
            reservedProviderIds.has(id)
              ? Effect.die(new Error(`"${id}" is a reserved provider ID`))
              : register(providers, id, provider),
        },
        popularity: {
          add: (name, popularity) => register(popularities, name, popularity),
        },
        musicbrainz: {
          add: (lookup) => register(musicbrainzLookups, musicbrainzLookupKey, lookup),
        },
        tracklists: {
          add: (id, lookup) => register(tracklists.sites, id, lookup),
        },
        outputs: {
          // `device:<DeviceId>` is the output ID of a Dyad device
          add: (id, urlOutputs) =>
            id === "device" || id.includes(":")
              ? Effect.die(new Error(`"${id}" is not a valid output ID`))
              : register(outputs.registrations, id, urlOutputs).pipe(
                  Effect.andThen(outputs.follow(id, urlOutputs)),
                ),
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
  ).pipe(Layer.provide(pluginHttpClient(version)));
