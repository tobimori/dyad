// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires a Node server factory
import { createServer } from "node:http";

import { ReplicaDatabase, nodeDatabaseLayer } from "@dyad/db/node";
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
  MediaCacheConfig,
  ServerIdentity,
  StreamPort,
  catalogLayer,
  coreServicesLayer,
  hlcClockFromDatabase,
  librarySyncLayer,
  pluginLayer,
  recommendationsLayer,
  serverRoutes,
  tracklistsLayer,
} from "@dyad/server-core";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import { HttpMiddleware, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import packageJson from "../package.json" with { type: "json" };
import { ServerConfig } from "./config.ts";
import { webApplicationLayer } from "./web.ts";

const builtinPlugins: ReadonlyArray<Plugin> = [
  localFilesPlugin,
  airplayPlugin,
  appleMusicPlugin,
  bandcampPlugin,
  castPlugin,
  deezerPlugin,
  hypemPlugin,
  mixesdbPlugin,
  musicbrainzPlugin,
  soundcloudPlugin,
  youtubePlugin,
];

export const serverLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { dataDirectory, port, allowedOrigins, mediaCacheBytes } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(dataDirectory, { recursive: true });
    const database = nodeDatabaseLayer(path.join(dataDirectory, "replica.sqlite"));
    const mediaCacheConfig = Layer.succeed(MediaCacheConfig, {
      directory: path.join(dataDirectory, "media"),
      maxBytes: mediaCacheBytes,
    });
    const streamPort = Layer.succeed(StreamPort, port);
    const identity = Layer.effect(
      ServerIdentity,
      ReplicaDatabase.use((value) =>
        Schema.decodeEffect(ServerDescriptor)({
          ...value,
          protocolVersion: 1,
          capabilities: { replication: false, playback: true, providerSync: false },
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
    const routes = Layer.mergeAll(serverRoutes, webApplicationLayer, browserAccess).pipe(
      Layer.provide(identity),
    );
    return Layer.mergeAll(
      // The first library imports, ISRC lookups, tracklist reads and scrobbles need what the plugins add
      Layer.mergeAll(librarySyncLayer, catalogLayer, tracklistsLayer, recommendationsLayer).pipe(
        Layer.provide(pluginLayer(builtinPlugins, packageJson.version)),
      ),
      HttpRouter.serve(routes).pipe(
        Layer.provide(
          NodeHttpServer.layer(() => createServer(), {
            // Speakers on the LAN open stream URLs
            host: "0.0.0.0",
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
          Layer.provideMerge(database),
        ),
      ),
    );
  }),
);
