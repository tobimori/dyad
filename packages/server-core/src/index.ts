import { ServerDescriptor, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer } from "effect";
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
import { preparePlayback, sourceResolversLayer, streamKeyLayer, streamRoute } from "./playback.ts";

export { pluginLayer } from "./plugin.ts";

export class ServerIdentity extends Context.Service<ServerIdentity, ServerDescriptor>()(
  "@dyad/server-core/ServerIdentity",
) {}

/** Replica services that plugins and routes share */
export const coreServicesLayer = Layer.mergeAll(
  sourceResolversLayer,
  accountProvidersLayer,
  streamKeyLayer,
  authCodesLayer,
);

export const serverRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const descriptor = yield* ServerIdentity;
    const handlers = ServerRpc.toLayer({
      describe: () => Effect.succeed(descriptor),
      setup: ({ setupCode, username, password, deviceName }) =>
        setup(setupCode, username, password, deviceName),
      login: ({ username, password, deviceName }) => login(username, password, deviceName),
      pair: ({ code, deviceName }) => pair(code, deviceName),
      listSources: () => listSources.pipe(Effect.orDie),
      preparePlayback: ({ sourceId, capabilities }) => preparePlayback(sourceId, capabilities),
      createPairingCode: () => createPairingCode,
      listDevices: () => listDevices.pipe(Effect.orDie),
      removeDevice: ({ deviceId }) => removeDevice(deviceId).pipe(Effect.orDie),
      listAccountProviders: () => listAccountProviders,
      listAccounts: () => listAccounts.pipe(Effect.orDie),
      linkAccount: ({ provider, credentials }) => linkAccount(provider, credentials),
      unlinkAccount: ({ provider }) => unlinkAccount(provider).pipe(Effect.orDie),
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
