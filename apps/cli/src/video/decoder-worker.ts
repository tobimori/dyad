// @effect-diagnostics nodeBuiltinImport:off -- the port to the main thread is in `node:worker_threads`
import { parentPort, workerData } from "node:worker_threads";

import LibAV from "@libav.js/variant-vp9-opus";
import { Data, Effect, Match, Option, Queue, Schema, flow } from "effect";

import { End, Failed, Frame, Info, Need, ToWorker, WorkerData } from "./messages.ts";

class DecodeError extends Data.TaggedError("DecodeError")<{ readonly cause: unknown }> {}

const call = <A>(run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => new DecodeError({ cause }) });

class Session {
  readonly id: number;
  readonly device: string;
  demuxer = 0;
  codec = 0;
  packet = 0;
  frame = 0;
  stream = 0;
  msPerTick = 1;
  /** The newest frame that was late when it was decoded, not converted yet */
  late: { readonly ms: number; readonly frame: LibAV.Frame } | null = null;
  ended = false;
  infoSent = false;

  constructor(id: number) {
    this.id = id;
    this.device = `video-${id}`;
  }
}

// BT.709 limited range, nearest neighbor scaling
const convert = (frame: LibAV.Frame, width: number, height: number, out: Uint8ClampedArray) => {
  const data = Schema.decodeUnknownSync(Schema.Uint8Array)(frame.data);
  const [luma, blue, red] = frame.layout ?? [];
  if (luma === undefined || blue === undefined || red === undefined) return;
  const sourceWidth = frame.width ?? width;
  const sourceHeight = frame.height ?? height;

  let o = 0;
  for (let y = 0; y < height; y++) {
    const sy = Math.floor((y * sourceHeight) / height);
    const lumaRow = luma.offset + sy * luma.stride;
    const blueRow = blue.offset + (sy >> 1) * blue.stride;
    const redRow = red.offset + (sy >> 1) * red.stride;
    for (let x = 0; x < width; x++) {
      const sx = Math.floor((x * sourceWidth) / width);
      const c = 1.164 * ((data[lumaRow + sx] ?? 16) - 16);
      const d = (data[blueRow + (sx >> 1)] ?? 128) - 128;
      const e = (data[redRow + (sx >> 1)] ?? 128) - 128;
      out[o] = c + 1.793 * e;
      out[o + 1] = c - 0.213 * d - 0.533 * e;
      out[o + 2] = c + 2.112 * d;
      out[o + 3] = 255;
      o += 4;
    }
  }
};

const decoder = Effect.gen(function* () {
  const port = parentPort;
  if (port === null) return yield* Effect.die("The video decoder runs only as a worker");

  const { base } = yield* Schema.decodeUnknownEffect(WorkerData)(workerData);
  // The factory finds its `.wasm` next to itself
  const libav = yield* call(() => LibAV.LibAV({ noworker: true, nothreads: true, base }));
  // libvpx prints its version for each decoder
  yield* call(() => libav.av_log_set_level(libav.AV_LOG_QUIET));

  const wakes = yield* Queue.dropping<void>(1);
  let wanted: number | null = null;
  let current: Session | null = null;
  let size = { width: 1, height: 1 };
  let credits = 0;
  let nowMs = Number.NEGATIVE_INFINITY;
  const buffers: Array<ArrayBuffer> = [];

  libav.onread = (name) => {
    if (current?.device === name) port.postMessage(Need.make({ session: current.id }));
  };

  const handle = (message: typeof ToWorker.Type) => {
    Match.valueTags(message, {
      Open: (open) => {
        // An end of input stops a read that waits for bytes of the old session
        if (current !== null && current.id !== open.session) {
          void libav.ff_reader_dev_send(current.device, null);
        }
        wanted = open.session;
        size = { width: open.width, height: open.height };
        credits = 0;
      },
      Data: (data) => {
        if (current?.id === data.session) void libav.ff_reader_dev_send(current.device, data.bytes);
      },
      Pull: (pull) => {
        credits += pull.frames;
        nowMs = pull.nowMs;
        buffers.push(...pull.buffers);
      },
      Resize: (resize) => {
        size = { width: resize.width, height: resize.height };
      },
    });
    Queue.offerUnsafe(wakes, undefined);
  };
  // Only `decoder.ts` posts here, so a message that does not decode cannot happen
  port.on("message", flow(Schema.decodeUnknownOption(ToWorker), Option.map(handle)));

  const send = (session: Session, ms: number, frame: LibAV.Frame) => {
    const sourceWidth = frame.width ?? 1;
    const sourceHeight = frame.height ?? 1;
    if (!session.infoSent) {
      session.infoSent = true;
      port.postMessage(
        Info.make({ session: session.id, width: sourceWidth, height: sourceHeight }),
      );
    }
    // The terminal scales the picture up, so a frame is never larger than the stream
    const scale = Math.min(1, size.width / sourceWidth, size.height / sourceHeight);
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const bytes = width * height * 4;
    // Buffers of an old size are dropped
    const pool = buffers.splice(0).filter((buffer) => buffer.byteLength === bytes);
    const rgba = new Uint8Array(pool.pop() ?? new ArrayBuffer(bytes));
    buffers.push(...pool);

    convert(frame, width, height, new Uint8ClampedArray(rgba.buffer));
    credits--;
    port.postMessage(Frame.make({ session: session.id, ms, width, height, rgba: rgba.buffer }), [
      rgba.buffer,
    ]);
  };

  // A late frame waits until the next frame shows whether it is still the one to show now
  const take = (session: Session, frame: LibAV.Frame) => {
    const ms = libav.i64tof64(frame.pts ?? 0, frame.ptshi ?? 0) * session.msPerTick;
    if (ms < nowMs) {
      session.late = { ms, frame };
      return;
    }
    if (session.late !== null) send(session, session.late.ms, session.late.frame);
    session.late = null;
    send(session, ms, frame);
  };

  const open = Effect.fn(function* (session: Session) {
    yield* call(() => libav.mkreaderdev(session.device));
    const [demuxer, streams] = yield* call(() => libav.ff_init_demuxer_file(session.device));
    session.demuxer = demuxer;
    const stream = streams.find((item) => item.codec_type === libav.AVMEDIA_TYPE_VIDEO);
    if (stream === undefined) return yield* new DecodeError({ cause: "The stream has no video" });

    const [, codec, packet, frame] = yield* call(() =>
      libav.ff_init_decoder("libvpx-vp9", { codecpar: stream.codecpar }),
    );
    session.codec = codec;
    session.packet = packet;
    session.frame = frame;
    session.stream = stream.index;
    session.msPerTick = (stream.time_base_num / stream.time_base_den) * 1000;
  });

  const decodeNext = Effect.fn(function* (session: Session) {
    const [result, packets] = yield* call(() =>
      libav.ff_read_frame_multi(session.demuxer, session.packet, { limit: 1 }),
    );
    const end = result === libav.AVERROR_EOF;
    if (!end && result !== 0 && result !== -libav.EAGAIN) {
      return yield* new DecodeError({ cause: `The demuxer failed with ${result}` });
    }
    const frames = yield* call(() =>
      libav.ff_decode_multi(
        session.codec,
        session.packet,
        session.frame,
        packets[session.stream] ?? [],
        { fin: end, ignoreErrors: true },
      ),
    );
    for (const frame of frames) take(session, frame);
    if (!end) return;

    if (session.late !== null) send(session, session.late.ms, session.late.frame);
    session.late = null;
    session.ended = true;
    port.postMessage(End.make({ session: session.id }));
  });

  const close = Effect.fn(
    function* (session: Session) {
      if (session.codec !== 0) {
        yield* call(() => libav.ff_free_decoder(session.codec, session.packet, session.frame));
      }
      if (session.demuxer !== 0) yield* call(() => libav.avformat_close_input_js(session.demuxer));
      yield* call(() => libav.unlink(session.device));
    },
    (effect) => effect.pipe(Effect.ignore),
  );

  // One loop makes all libav calls, because a suspended read cannot share the WASM stack
  const step = Effect.gen(function* () {
    const session = current;
    if (wanted !== null && session?.id !== wanted) {
      current = null;
      if (session !== null) yield* close(session);
      const next = new Session(wanted);
      current = next;
      return yield* open(next);
    }
    if (session !== null && !session.ended && credits > 0) return yield* decodeNext(session);
    yield* Queue.take(wakes);
  }).pipe(
    Effect.catch((error) =>
      Effect.gen(function* () {
        const failed = current;
        current = null;
        if (failed === null) return;
        if (failed.id === wanted) {
          port.postMessage(Failed.make({ session: failed.id, reason: String(error.cause) }));
          wanted = null;
        }
        yield* close(failed);
      }),
    ),
  );

  return yield* Effect.forever(step);
});

Effect.runFork(decoder);
