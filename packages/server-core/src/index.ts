import { orDieOnDatabaseError } from "@dyad/db/node";
import { ServerDescriptor, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import {
  accountProvidersLayer,
  linkAccount,
  listAccountProviders,
  listAccounts,
  unlinkAccount,
} from "./accounts.ts";
import {
  authCodesLayer,
  authenticationLayer,
  createPairingCode,
  listDevices,
  login,
  pair,
  removeDevice,
  setup,
} from "./auth.ts";
import { listSources } from "./library.ts";
import { preparePlayback, streamKeyLayer, streamRoute } from "./playback.ts";
import { sourceResolversLayer, sourceSearchesLayer } from "./providers.ts";
import { providerCacheSweepLayer, search } from "./search.ts";

export { pluginLayer } from "./plugin.ts";

export class ServerIdentity extends Context.Service<ServerIdentity, ServerDescriptor>()(
  "@dyad/server-core/ServerIdentity",
) {}

/** Replica services that plugins and routes share */
export const coreServicesLayer = Layer.mergeAll(
  sourceResolversLayer,
  sourceSearchesLayer,
  accountProvidersLayer,
  streamKeyLayer,
  authCodesLayer,
  providerCacheSweepLayer,
);

export const serverRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const descriptor = yield* ServerIdentity;
    const handlers = ServerRpc.toLayer({
      describe: () => Effect.succeed(descriptor),
      setup: (payload) => setup(payload).pipe(orDieOnDatabaseError),
      login: (payload) => login(payload).pipe(orDieOnDatabaseError),
      pair: ({ code, deviceName }) => pair(code, deviceName).pipe(orDieOnDatabaseError),
      listSources: () => listSources.pipe(orDieOnDatabaseError),
      search: ({ query }) => search(query).pipe(Stream.orDie),
      preparePlayback: ({ sourceId, capabilities }) =>
        preparePlayback(sourceId, capabilities).pipe(orDieOnDatabaseError),
      createPairingCode: () => createPairingCode,
      listDevices: () => listDevices.pipe(orDieOnDatabaseError),
      removeDevice: ({ deviceId }) => removeDevice(deviceId).pipe(orDieOnDatabaseError),
      listAccountProviders: () => listAccountProviders,
      listAccounts: () => listAccounts.pipe(orDieOnDatabaseError),
      linkAccount: ({ provider, credentials }) =>
        linkAccount(provider, credentials).pipe(orDieOnDatabaseError),
      unlinkAccount: ({ provider }) => unlinkAccount(provider).pipe(orDieOnDatabaseError),
    });

    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/dyad/server",
        HttpServerResponse.schemaJson(ServerDescriptor)(descriptor),
      ),
      HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
      streamRoute,
      RpcServer.layerHttp({ group: ServerRpc, path: "/rpc" }).pipe(
        Layer.provide(handlers),
        Layer.provide(authenticationLayer),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
  }),
);
