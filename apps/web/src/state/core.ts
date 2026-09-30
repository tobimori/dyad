import { CoreWorkerRpc } from "@dyad/domain";
import { BrowserWorker } from "@effect/platform-browser";
import { Effect, Layer } from "effect";
import { AtomRpc } from "effect/unstable/reactivity";
import { RpcClient } from "effect/unstable/rpc";

const workerPlatform = Layer.unwrap(
  Effect.gen(function* () {
    const worker = yield* Effect.acquireRelease(
      Effect.sync(
        () => new Worker(new URL("../workers/core.worker.ts", import.meta.url), { type: "module" }),
      ),
      (worker) => Effect.sync(() => worker.terminate()),
    );
    return BrowserWorker.layer(() => worker);
  }),
);

export class CoreClient extends AtomRpc.Service<CoreClient>()("@dyad/web/CoreClient", {
  group: CoreWorkerRpc,
  protocol: RpcClient.layerProtocolWorker({ size: 1 }).pipe(Layer.provide(workerPlatform)),
}) {}

export const workerDescriptor = CoreClient.query("describe", undefined, {
  timeToLive: "5 minutes",
});
export const serverDescriptor = CoreClient.query("server", undefined, {
  timeToLive: "30 seconds",
});
