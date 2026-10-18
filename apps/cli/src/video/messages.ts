import { Schema } from "effect";

const Size = { width: Schema.Int, height: Schema.Int };

/** Starts a new byte stream. The worker scales frames to fit in `width` by `height`. */
export const Open = Schema.TaggedStruct("Open", { session: Schema.Int, ...Size });
/** The next bytes of the session, or `null` at its end */
export const Data = Schema.TaggedStruct("Data", {
  session: Schema.Int,
  bytes: Schema.NullOr(Schema.Uint8Array),
});
/**
 * Lets the worker send `frames` more frames. Frames that end before `nowMs` are decoded but not
 * converted. `buffers` come back from shown frames for reuse.
 */
export const Pull = Schema.TaggedStruct("Pull", {
  frames: Schema.Int,
  nowMs: Schema.Finite,
  buffers: Schema.Array(Schema.instanceOf(ArrayBuffer)),
});
export const Resize = Schema.TaggedStruct("Resize", Size);
export const ToWorker = Schema.Union([Open, Data, Pull, Resize]);

/** The session waits for bytes */
export const Need = Schema.TaggedStruct("Need", { session: Schema.Int });
export const Info = Schema.TaggedStruct("Info", { session: Schema.Int, ...Size });
/** RGBA pixels, shown from `ms` on the timeline of the source */
export const Frame = Schema.TaggedStruct("Frame", {
  session: Schema.Int,
  ms: Schema.Finite,
  ...Size,
  rgba: Schema.instanceOf(ArrayBuffer),
});
export const End = Schema.TaggedStruct("End", { session: Schema.Int });
export const Failed = Schema.TaggedStruct("Failed", { session: Schema.Int, reason: Schema.String });
export const FromWorker = Schema.Union([Need, Info, Frame, End, Failed]);

/** The file URL of the folder with the libav.js factory module and its `.wasm` */
export const WorkerData = Schema.Struct({ base: Schema.String });
