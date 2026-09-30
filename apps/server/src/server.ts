// @effect-diagnostics-next-line nodeBuiltinImport:off -- NodeHttpServer requires a Node server factory
import { createServer } from "node:http";

import { ReplicaDatabase, nodeDatabaseLayer } from "@dyad/db/node";
import { ServerDescriptor } from "@dyad/domain";
import { ServerIdentity, serverRoutes } from "@dyad/server-core";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, FileSystem, Layer, Path, Schema } from "effect";
import {
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import { ServerConfig } from "./config.ts";
import { webApplicationLayer } from "./web.ts";

export const serverLayer = Layer.unwrap(
  Effect.gen(function* makeServerLayer() {
    const { dataDirectory, port, allowedOrigins } = yield* ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    yield* fs.makeDirectory(dataDirectory, { recursive: true });
    const database = nodeDatabaseLayer({ filename: path.join(dataDirectory, "replica.sqlite") });
    const identity = Layer.effect(
      ServerIdentity,
      ReplicaDatabase.use((value) =>
        Schema.decodeEffect(ServerDescriptor)({
          ...value,
          protocolVersion: 1,
          capabilities: { replication: false, playback: false, providerSync: false },
        }),
      ),
    ).pipe(Layer.provide(database));

    const browserAccess = HttpRouter.middleware(
      Effect.gen(function* browserAccessMiddleware() {
        const cors = HttpMiddleware.cors({
          allowedOrigins: (origin) => allowedOrigins.includes(origin),
          allowedMethods: ["GET", "POST", "OPTIONS"],
          allowedHeaders: ["Content-Type"],
        });
        return (httpEffect) =>
          Effect.gen(function* checkBrowserOrigin() {
            const request = yield* HttpServerRequest.HttpServerRequest;
            const origin = request.headers.origin;
            if (origin !== undefined && !allowedOrigins.includes(origin)) {
              return HttpServerResponse.empty({ status: 403 });
            }
            return yield* cors(httpEffect);
          });
      }),
      { global: true },
    );
    const routes = Layer.mergeAll(serverRoutes, webApplicationLayer, browserAccess).pipe(
      Layer.provide(identity),
    );
    return HttpRouter.serve(routes).pipe(
      Layer.provide(NodeHttpServer.layer(() => createServer(), { host: "127.0.0.1", port })),
    );
  }),
);
