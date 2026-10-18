// First, because libuv reads the size when a module uses the pool for the first time
import "./threadpool.ts";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Layer } from "effect";

import { ServerConfig } from "./config.ts";
import { serverLayer } from "./server.ts";

serverLayer.pipe(
  Layer.provide(ServerConfig.layer),
  Layer.provide(NodeServices.layer),
  Layer.launch,
  NodeRuntime.runMain,
);
