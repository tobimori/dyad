import { dieOnDatabaseError, orDieOnDatabaseError } from "@dyad/db/node";
import { ServerDescriptor, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { linkAccount, listAccountProviders, listAccounts, unlinkAccount } from "./accounts.ts";
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
import { listRecentPlays, recordPlay } from "./history.ts";
import { jobsLayer } from "./jobs.ts";
import { preparePlayback, streamKeyLayer, streamRoute } from "./playback.ts";
import { providerCacheSweepLayer } from "./provider-cache.ts";
import { popularitiesLayer, providersLayer } from "./providers.ts";
import { search } from "./search.ts";
import { listSources } from "./sources.ts";

export { pluginLayer } from "./plugin.ts";

export class ServerIdentity extends Context.Service<ServerIdentity, ServerDescriptor>()(
  "@dyad/server-core/ServerIdentity",
) {}

/** Replica services that plugins and routes share */
export const coreServicesLayer = Layer.mergeAll(
  providersLayer,
  popularitiesLayer,
  streamKeyLayer,
  authCodesLayer,
  providerCacheSweepLayer,
).pipe(Layer.provideMerge(jobsLayer));

export const serverRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const descriptor = yield* ServerIdentity;
    const handlers = ServerRpc.toLayer({
      describe: () => Effect.succeed(descriptor),
      setup: (payload) => setup(payload).pipe(orDieOnDatabaseError("setup")),
      login: (payload) => login(payload).pipe(orDieOnDatabaseError("login")),
      pair: ({ code, deviceName }) => pair(code, deviceName).pipe(orDieOnDatabaseError("pair")),
      listSources: () => listSources.pipe(orDieOnDatabaseError("listSources")),
      listRecentPlays: () => listRecentPlays.pipe(orDieOnDatabaseError("listRecentPlays")),
      search: ({ query }) =>
        // Only database errors remain
        search(query).pipe(Stream.catch(() => Stream.fromEffect(dieOnDatabaseError("search")))),
      preparePlayback: ({ sourceId, capabilities }) =>
        preparePlayback(sourceId, capabilities).pipe(orDieOnDatabaseError("preparePlayback")),
      recordPlay: (payload) => recordPlay(payload).pipe(orDieOnDatabaseError("recordPlay")),
      createPairingCode: () => createPairingCode,
      listDevices: () => listDevices.pipe(orDieOnDatabaseError("listDevices")),
      removeDevice: ({ deviceId }) =>
        removeDevice(deviceId).pipe(orDieOnDatabaseError("removeDevice")),
      listAccountProviders: () => listAccountProviders,
      listAccounts: () => listAccounts.pipe(orDieOnDatabaseError("listAccounts")),
      linkAccount: ({ provider, credentials }) =>
        linkAccount(provider, credentials).pipe(orDieOnDatabaseError("linkAccount")),
      unlinkAccount: ({ provider }) =>
        unlinkAccount(provider).pipe(orDieOnDatabaseError("unlinkAccount")),
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
