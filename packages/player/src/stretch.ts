import { Data, Effect } from "effect";

import { timelineRate } from "./resampler.ts";

/** Changes the tempo of interleaved stereo audio at 44.1 kHz and keeps its pitch */
export class Stretcher extends Data.Class<{
  /** Input frames that `process` reads ahead of the output that it gives */
  readonly inputLatency: number;
  /** Output frames between the input that `process` reads and the output of it */
  readonly outputLatency: number;
  /** Clears the state and loads `frames` frames as the input before the next `process` */
  readonly seek: (input: Float32Array, frames: number, rate: number) => void;
  /** Reads `inputs` frames and writes `outputs` frames to `output` from frame `at` */
  readonly process: (
    input: Float32Array,
    inputs: number,
    output: Float32Array,
    at: number,
    outputs: number,
  ) => void;
}> {}

/** Frames that one `seek` or `process` call can take */
export const stretcherCapacity = 16_384;

// oxlint-disable-next-line @project/no-shape-declarations -- the exports of the signalsmith-stretch 1.3.2 WASM module
interface SignalsmithWasm {
  readonly HEAP8: Int8Array;
  _presetDefault(channels: number, rate: number): void;
  _presetCheaper(channels: number, rate: number): void;
  _setBuffers(channels: number, length: number): number;
  _inputLatency(): number;
  _outputLatency(): number;
  _seek(frames: number, rate: number): void;
  _process(inputs: number, outputs: number): void;
}

class WorkletProcessor {
  // The subclass reads the channel count from these options
  constructor(_options: { readonly numberOfOutputs?: number }) {}
  readonly port = { postMessage: () => this.ready() };
  ready = () => {};
  declare readonly wasmModule: SignalsmithWasm;
}

let processorClass: Promise<typeof WorkletProcessor> | undefined;

// signalsmith-stretch 1.3.2 exports only an AudioWorklet node. Its worklet branch gives the WASM
// factory to a processor class, so stand-ins for the worklet globals give a headless instance.
const loadProcessorClass = () => {
  if (processorClass !== undefined) return processorClass;
  let registered = WorkletProcessor;
  // The processor reads `sampleRate` also when it configures an instance later
  Object.assign(globalThis, {
    AudioWorkletProcessor: WorkletProcessor,
    registerProcessor: (_name: string, processor: typeof WorkletProcessor) => {
      registered = processor;
    },
    sampleRate: timelineRate,
  });
  // @ts-expect-error -- signalsmith-stretch 1.3.2 has no types, and only its side effect is used
  processorClass = import("signalsmith-stretch").then(() => {
    Reflect.deleteProperty(globalThis, "AudioWorkletProcessor");
    Reflect.deleteProperty(globalThis, "registerProcessor");
    return registered;
  });
  return processorClass;
};

/** A stretcher with the default preset, or the `cheaper` one for weak hosts */
export const openStretcher = (preset: "default" | "cheaper" = "default") =>
  Effect.gen(function* () {
    const Processor = yield* Effect.promise(loadProcessorClass);
    const wasm = yield* Effect.callback<SignalsmithWasm>((resume) => {
      const processor = new Processor({});
      processor.ready = () => resume(Effect.succeed(processor.wasmModule));
    });
    if (preset === "cheaper") wasm._presetCheaper(2, timelineRate);
    else wasm._presetDefault(2, timelineRate);
    const pointer = wasm._setBuffers(2, stretcherCapacity);
    // The WASM memory can grow, so the views are new for each call
    const buffer = (index: number, frames: number) =>
      new Float32Array(wasm.HEAP8.buffer, pointer + index * stretcherCapacity * 4, frames);

    const load = (input: Float32Array, frames: number) => {
      const left = buffer(0, frames);
      const right = buffer(1, frames);
      for (let frame = 0; frame < frames; frame++) {
        left[frame] = input[2 * frame] ?? 0;
        right[frame] = input[2 * frame + 1] ?? 0;
      }
    };

    return new Stretcher({
      inputLatency: wasm._inputLatency(),
      outputLatency: wasm._outputLatency(),
      seek: (input, frames, rate) => {
        load(input, frames);
        wasm._seek(frames, rate);
      },
      process: (input, inputs, output, at, outputs) => {
        load(input, inputs);
        wasm._process(inputs, outputs);
        const left = buffer(2, outputs);
        const right = buffer(3, outputs);
        for (let frame = 0; frame < outputs; frame++) {
          output[2 * (at + frame)] = left[frame] ?? 0;
          output[2 * (at + frame) + 1] = right[frame] ?? 0;
        }
      },
    });
  });
