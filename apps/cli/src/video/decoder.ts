// @effect-diagnostics nodeBuiltinImport:off -- a worker thread is outside the Effect runtime
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";

import { Schema, flow } from "effect";

import { seaAssetRoot } from "../sea-assets.ts";
import { Data, Failed, FromWorker, Open, Pull, Resize, WorkerData } from "./messages.ts";
import { workerCode } from "./worker-code.ts";

// `vite.config.ts` puts the factory module and the `.wasm` of libav.js into `libav/`
const libavBase = () => {
  if (seaAssetRoot !== null) return pathToFileURL(join(seaAssetRoot, "libav")).href;
  const entry = import.meta.resolve("@libav.js/variant-vp9-opus");
  return entry.slice(0, entry.lastIndexOf("/"));
};

/** A VP9 decoder in a worker thread, so that decoding does not delay the user interface */
export class VideoDecoder {
  private readonly worker: Worker;

  constructor(onMessage: (message: typeof FromWorker.Type) => void) {
    this.worker = new Worker(workerCode, {
      eval: true,
      workerData: WorkerData.make({ base: libavBase() }),
      // libav.js prints to the console, which would draw over the user interface
      stdout: true,
      stderr: true,
    });
    this.worker.stdout.resume();
    this.worker.stderr.resume();
    this.worker.on("message", flow(Schema.decodeUnknownSync(FromWorker), onMessage));
    this.worker.on("error", (error) =>
      onMessage(Failed.make({ session: -1, reason: String(error) })),
    );
  }

  open(session: number, width: number, height: number) {
    this.worker.postMessage(Open.make({ session, width, height }));
  }

  /** `bytes` moves to the worker; `null` ends the session's input */
  data(session: number, bytes: Uint8Array<ArrayBuffer> | null) {
    this.worker.postMessage(Data.make({ session, bytes }), bytes === null ? [] : [bytes.buffer]);
  }

  /** `buffers` move to the worker */
  pull(frames: number, nowMs: number, buffers: ReadonlyArray<ArrayBuffer>) {
    this.worker.postMessage(Pull.make({ frames, nowMs, buffers }), [...buffers]);
  }

  resize(width: number, height: number) {
    this.worker.postMessage(Resize.make({ width, height }));
  }

  close() {
    void this.worker.terminate();
  }
}
