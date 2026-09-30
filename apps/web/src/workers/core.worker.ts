import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { CoreWorkerRpc } from "@dyad/domain";
import { BrowserWorkerRunner } from "@effect/platform-browser";
import { Effect, Layer } from "effect";
import { RpcServer } from "effect/unstable/rpc";

const handlers = CoreWorkerRpc.toLayer({
  describe: () =>
    Effect.sync(() => ({
      execution: "worker" as const,
      secureContext: globalThis.isSecureContext,
      persistentStorageAvailable: typeof navigator.storage?.getDirectory === "function",
    })),
  server: () =>
    ServerConnection.use((client) => client.describe()).pipe(
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => null),
    ),
});

const worker = RpcServer.layer(CoreWorkerRpc).pipe(
  Layer.provide(handlers),
  Layer.provide(
    serverConnectionLayer(import.meta.env.VITE_DYAD_SERVER_URL || globalThis.location.origin),
  ),
  Layer.provide(RpcServer.layerProtocolWorkerRunner),
  Layer.provide(BrowserWorkerRunner.layer),
);

Layer.launch(worker).pipe(Effect.runFork);
