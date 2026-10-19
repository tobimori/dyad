import { timelineRate } from "@dyad/player";
import { OutputError, TimedOutput, UrlMedia } from "@dyad/plugin";
import type { UrlOutput } from "@dyad/plugin";
import {
  Cause,
  Clock,
  Crypto,
  Data,
  Deferred,
  Effect,
  Option,
  Queue,
  Schedule,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { Outputs } from "./outputs.ts";

// 23 ms of audio in each FLAC frame, so that the stream follows the target closely
const blockFrames = 1024;
// A speaker gets this much audio at once when it connects, so that it can start at once
const burstFrames = timelineRate;
// A speaker that leaves this much audio unread stopped reading
const backlogFrames = 5 * timelineRate;
// Sonos 97.2 plays a stream about 0.3 s after the load, with 1.2 to 1.4 s of audio
const startTimeout = "10 seconds";
const sendInterval = "20 millis";
const contentType = "audio/flac";

const nowUs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1000n));

const crcTable = (width: 8 | 16, polynomial: number) =>
  Array.from({ length: 256 }, (_, byte) => {
    const top = 1 << (width - 1);
    const mask = (1 << width) - 1;
    let crc = byte << (width - 8);
    for (let bit = 0; bit < 8; bit++) crc = (crc & top ? (crc << 1) ^ polynomial : crc << 1) & mask;
    return crc;
  });

const crc8Table = crcTable(8, 0x07);
const crc16Table = crcTable(16, 0x8005);

const crc8 = (bytes: Uint8Array) => bytes.reduce((crc, byte) => crc8Table[crc ^ byte] ?? 0, 0);

const crc16 = (bytes: Uint8Array) =>
  bytes.reduce((crc, byte) => ((crc << 8) & 0xffff) ^ (crc16Table[(crc >> 8) ^ byte] ?? 0), 0);

// The frame number in the UTF-8 coding of FLAC
const codedNumber = (value: number) => {
  if (value < 0x80) return [value];
  const shorter = [0x800, 0x10000, 0x200000, 0x4000000].findIndex((limit) => value < limit);
  const length = shorter === -1 ? 6 : shorter + 2;
  const tail = Array.from(
    { length: length - 1 },
    (_, index) => 0x80 | ((value >>> (6 * (length - 2 - index))) & 0x3f),
  );
  return [((0xff00 >> length) & 0xff) | (value >>> (6 * (length - 1))), ...tail];
};

// `fLaC` and STREAMINFO: 44.1 kHz, 2 channels, 16 bits, fixed block size, unknown length
const flacHeader = () => {
  const bytes = new Uint8Array(4 + 4 + 34);
  const view = new DataView(bytes.buffer);
  bytes.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  view.setUint16(8, blockFrames);
  view.setUint16(10, blockFrames);
  view.setBigUint64(18, (BigInt(timelineRate) << 44n) | (1n << 41n) | (15n << 36n));
  return bytes;
};

// One frame of 16-bit stereo with verbatim subframes. Silence costs as much as sound, so that a
// speaker that buffers by bytes starts after the same time.
const flacFrame = (number: number, pcm: Float32Array) => {
  const header = Uint8Array.from([
    0xff,
    0xf8,
    // Block size in 16 bits at the end of the header, 44.1 kHz
    0x79,
    // Left and right, 16 bits
    0x18,
    ...codedNumber(number),
    (blockFrames - 1) >> 8,
    (blockFrames - 1) & 0xff,
  ]);
  const size = header.length + 1 + 2 * (1 + 2 * blockFrames) + 2;
  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  bytes.set(header);
  bytes[header.length] = crc8(header);
  let offset = header.length + 1;
  for (const channel of [0, 1]) {
    // Verbatim subframe without wasted bits
    bytes[offset] = 0x02;
    offset += 1;
    for (let frame = 0; frame < blockFrames; frame++) {
      const sample = Math.round((pcm[2 * frame + channel] ?? 0) * 32767);
      view.setInt16(offset, Math.max(-32768, Math.min(32767, sample)));
      offset += 2;
    }
  }
  view.setUint16(offset, crc16(bytes.subarray(0, offset)));
  return bytes;
};

// Stream frame `frame` plays the first samples
class Block extends Data.Class<{ readonly frame: number; readonly pcm: Float32Array }> {}

// One request of the device
class Connection extends Data.Class<{
  readonly queue: Queue.Queue<Uint8Array, Cause.Done>;
  readonly atUs: number;
}> {
  // Stream frames that went into the queue
  written = 0;
  frames = 0;
}

/**
 * Plays a live FLAC stream on `output` and gives it as a timed output. It opens when the device
 * plays the stream, and the device must not pause or stop it until the scope closes; then it
 * pauses. Its lead is the audio that the device holds.
 */
export const openLiveStream = Effect.fn("openLiveStream")(function* (
  output: UrlOutput,
  origin: string,
  title: string,
) {
  const outputs = yield* Outputs;
  const id = yield* Crypto.Crypto.use((crypto) => crypto.randomUUIDv4()).pipe(Effect.orDie);
  const url = `${origin}/live/${id}`;
  const lost = yield* Deferred.make<never, OutputError>();
  const lose = (reason: string) => Deferred.fail(lost, new OutputError({ reason }));

  const state = {
    connection: Option.none<Connection>(),
    // Server time at which stream frame 0 plays
    anchorUs: Option.none<number>(),
    blocks: Array.of<Block>(),
  };

  // The audio of stream frames `from` to `from + blockFrames`, silence where no block is
  const take = (from: number) => {
    const pcm = new Float32Array(blockFrames * 2);
    for (const block of state.blocks) {
      const first = Math.max(from, block.frame);
      const last = Math.min(from + blockFrames, block.frame + block.pcm.length / 2);
      if (first >= last) continue;
      const samples = block.pcm.subarray((first - block.frame) * 2, (last - block.frame) * 2);
      pcm.set(samples, (first - from) * 2);
    }
    state.blocks = state.blocks.filter(
      (block) => block.frame + block.pcm.length / 2 > from + blockFrames,
    );
    return pcm;
  };

  // Each request starts the stream again, so the device plays the stream of the last request
  const connect = Effect.gen(function* () {
    if (Option.isSome(state.anchorUs)) yield* lose("The device opened the stream again");
    if (Option.isSome(state.connection)) Queue.endUnsafe(state.connection.value.queue);
    const queue = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    Queue.offerUnsafe(queue, flacHeader());
    state.connection = Option.some(new Connection({ queue, atUs: yield* nowUs }));
    return Stream.fromQueue(queue);
  });

  // Real time from the connection on, after the burst
  const send = Effect.gen(function* () {
    if (Option.isNone(state.connection)) return;
    const connection = state.connection.value;
    const target = burstFrames + ((yield* nowUs) - connection.atUs) * (timelineRate / 1_000_000);
    while (connection.written + blockFrames <= target) {
      Queue.offerUnsafe(connection.queue, flacFrame(connection.frames, take(connection.written)));
      connection.written += blockFrames;
      connection.frames += 1;
    }
    if (Queue.sizeUnsafe(connection.queue) * blockFrames > backlogFrames) {
      yield* lose("The device stopped reading the stream");
    }
  });

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      if (Option.isSome(state.connection)) Queue.endUnsafe(state.connection.value.queue);
    }),
  );
  yield* outputs.addLiveStream(id, connect);
  yield* Effect.forkScoped(Effect.repeat(send, Schedule.spaced(sendInterval)));
  // Before the stream ends, so that the device does not play out its buffer. Another controller
  // can play on it already.
  yield* Effect.addFinalizer(() =>
    output.status.pipe(
      Stream.runHead,
      Effect.flatMap((status) =>
        Option.exists(status, (current) => current.url === url) ? output.pause : Effect.void,
      ),
      Effect.timeout("3 seconds"),
      Effect.ignore,
    ),
  );

  yield* output.load(
    new UrlMedia({
      url,
      contentType,
      title,
      artist: null,
      album: null,
      artworkUrl: null,
      durationMs: null,
    }),
  );
  const started = yield* output.status.pipe(
    Stream.filter((status) => status.url === url && status.state === "playing"),
    Stream.runHead,
    Effect.timeoutOption(startTimeout),
    Effect.map(Option.flatten),
  );
  if (Option.isNone(started) || Option.isNone(state.connection)) {
    return yield* new OutputError({ reason: "The device did not play the live stream" });
  }
  const anchorUs = yield* nowUs;
  state.anchorUs = Option.some(anchorUs);
  const heldMs = (state.connection.value.written * 1000) / timelineRate;
  yield* Effect.logInfo("Live stream plays").pipe(
    Effect.annotateLogs({ heldMs: Math.round(heldMs) }),
  );

  // Another controller paused, stopped or replaced it
  yield* output.status.pipe(
    Stream.runForEach((status) =>
      status.url === url && (status.state === "playing" || status.state === "buffering")
        ? Effect.void
        : lose(`The device left the live stream (${status.state})`),
    ),
    Effect.catch((error) => lose(error.reason)),
    Effect.forkScoped,
  );

  return new TimedOutput({
    // The device holds the burst and what came while it started; a frame goes out per send
    leadMs: Math.ceil(heldMs + (1000 * blockFrames) / timelineRate) + 20,
    write: (playAtUs, pcm) =>
      Effect.sync(() => {
        const frame = Math.round(((playAtUs - anchorUs) * timelineRate) / 1_000_000);
        state.blocks.push(new Block({ frame, pcm }));
      }),
    flush: Effect.sync(() => {
      state.blocks = [];
    }),
    // The core sets the volume of the URL output
    setVolume: () => Effect.void,
    setMedia: () => Effect.void,
    closed: Deferred.await(lost),
  });
});

/** Live streams of URL outputs. The random ID in the URL is the grant. */
export const liveRoute = HttpRouter.add(
  "*",
  "/live/:id",
  Effect.gen(function* () {
    const { method } = yield* HttpServerRequest.HttpServerRequest;
    if (method !== "GET" && method !== "HEAD") return HttpServerResponse.empty({ status: 405 });
    const { id } = yield* HttpRouter.schemaParams(Schema.Struct({ id: Schema.String }));
    const connect = (yield* Outputs).liveStream(id);
    if (connect === undefined) return HttpServerResponse.empty({ status: 404 });
    if (method === "HEAD") return HttpServerResponse.stream(Stream.empty, { contentType });
    return HttpServerResponse.stream(yield* connect, { contentType });
  }),
);
