// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires a Node server factory
import { createServer } from "node:http";

import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { serverPeer } from "@dyad/db";
import { Database, ReplicaDatabase, nodeDatabaseLayer } from "@dyad/db/node";
import { ServerDescriptor } from "@dyad/domain";
import type { Plugin } from "@dyad/plugin";
import { airplayPlugin } from "@dyad/plugin-airplay/server";
import { appleMusicPlugin } from "@dyad/plugin-apple-music/server";
import { bandcampPlugin } from "@dyad/plugin-bandcamp/server";
import { castPlugin } from "@dyad/plugin-cast/server";
import { deezerPlugin } from "@dyad/plugin-deezer/server";
import { hypemPlugin } from "@dyad/plugin-hypem/server";
import { localFilesPlugin } from "@dyad/plugin-local-files/server";
import { mixesdbPlugin } from "@dyad/plugin-mixesdb/server";
import { musicbrainzPlugin } from "@dyad/plugin-musicbrainz/server";
import { soundcloudPlugin } from "@dyad/plugin-soundcloud/server";
import { youtubePlugin } from "@dyad/plugin-youtube/server";
import {
  HomeServer,
  MediaCacheConfig,
  ServerIdentity,
  StreamPort,
  catalogLayer,
  coreServicesLayer,
  hlcClockFromDatabase,
  librarySyncLayer,
  pluginLayer,
  peerSyncLayer,
  recommendationsLayer,
  serverRoutes,
  tracklistsLayer,
} from "@dyad/server-core";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Option, Path, Redacted, Schema } from "effect";
import { and, isNotNull } from "drizzle-orm";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../package.json" with { type: "json" };
import { ServerConfig } from "./config.ts";

const builtinPlugins: ReadonlyArray<Plugin> = [
  localFilesPlugin,
  appleMusicPlugin,
  bandcampPlugin,
  deezerPlugin,
  hypemPlugin,
  mixesdbPlugin,
  musicbrainzPlugin,
  soundcloudPlugin,
  youtubePlugin,
];

// The server replica holds the rooms of the speakers. A device replica holds only the room of its
// device, so that two replicas never drive one speaker.
const outputPlugins: ReadonlyArray<Plugin> = [airplayPlugin, castPlugin];

/** A full replica: database, plugins, jobs, replication and the HTTP server. `routes` adds routes. */
export const replicaLayer = <E, R>(routes: Layer.Layer<never, E, R>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const { dataDirectory, host, port, allowedOrigins, mediaCacheBytes, device } =
        yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;

      yield* fs.makeDirectory(dataDirectory, { recursive: true });
      const database = nodeDatabaseLayer(path.join(dataDirectory, "replica.sqlite"));
      const mediaCacheConfig = Layer.succeed(MediaCacheConfig, {
        directory: path.join(dataDirectory, "media"),
        maxBytes: mediaCacheBytes,
      });
      const streamPort = Layer.succeed(StreamPort, port);
      // The peer that this replica joined, through the same token as its replication
      const homeServer = Layer.unwrap(
        Effect.gen(function* () {
          const db = yield* Database;
          const [peer] = yield* db
            .select({ url: serverPeer.url, token: serverPeer.token })
            .from(serverPeer)
            .where(and(isNotNull(serverPeer.url), isNotNull(serverPeer.token)))
            .limit(1)
            .pipe(Effect.orDie);
          if (!device || peer?.url == null || peer.token === null) {
            return Layer.succeed(HomeServer, Option.none());
          }
          return Layer.effect(
            HomeServer,
            Effect.map(ServerConnection, (client) => Option.some(client)),
          ).pipe(
            Layer.provide(serverConnectionLayer(peer.url, Option.some(Redacted.make(peer.token)))),
            Layer.orDie,
          );
        }),
      );
      const identity = Layer.effect(
        ServerIdentity,
        ReplicaDatabase.use((value) =>
          Schema.decodeEffect(ServerDescriptor)({
            ...value,
            protocolVersion: 1,
            capabilities: { replication: true, playback: true, providerSync: false },
          }),
        ),
      );

      const isAllowedOrigin = (origin: string) => allowedOrigins.includes(origin);
      const cors = HttpMiddleware.cors({
        allowedOrigins: isAllowedOrigin,
        allowedMethods: ["GET", "POST", "OPTIONS"],
        allowedHeaders: ["Content-Type"],
      });
      const browserAccess = HttpRouter.middleware(
        (httpEffect) =>
          Effect.gen(function* () {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const origin = request.headers.origin;
            if (origin !== undefined && !isAllowedOrigin(origin)) {
              return HttpServerResponse.empty({ status: 403 });
            }
            return yield* cors(httpEffect);
          }),
        { global: true },
      );
      const allRoutes = Layer.mergeAll(serverRoutes, routes, browserAccess).pipe(
        Layer.provide(identity),
      );
      return Layer.mergeAll(
        // The first library imports, ISRC lookups, tracklist reads and scrobbles need what the plugins
        // add. Rows from peers need the providers too: their fact ranks rank assertions.
        Layer.mergeAll(
          librarySyncLayer,
          catalogLayer,
          tracklistsLayer,
          recommendationsLayer,
          peerSyncLayer,
        ).pipe(
          Layer.provide(
            pluginLayer(
              device ? builtinPlugins : [...builtinPlugins, ...outputPlugins],
              packageJson.version,
            ),
          ),
        ),
        HttpRouter.serve(allRoutes).pipe(
          Layer.provide(
            NodeHttpServer.layer(() => createServer(), {
              host,
              port,
              // RPC WebSockets stay open, so the default 20 second grace period always runs out
              gracefulShutdownTimeout: "500 millis",
            }),
          ),
        ),
      ).pipe(
        Layer.provide(
          coreServicesLayer.pipe(
            Layer.provide(mediaCacheConfig),
            Layer.provide(streamPort),
            Layer.provideMerge(hlcClockFromDatabase),
            Layer.provideMerge(homeServer),
            Layer.provideMerge(database),
          ),
        ),
      );
    }),
  );
