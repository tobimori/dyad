// First, because libuv reads the size when a module uses the pool for the first time
import "@dyad/host/threadpool";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { ServerConfig, replicaLayer } from "@dyad/host";

import { webApplicationLayer } from "./web.ts";

replicaLayer(webApplicationLayer).pipe(
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
