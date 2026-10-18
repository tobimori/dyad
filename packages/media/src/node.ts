// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto cannot hash a stream incrementally
import { createHash } from "node:crypto";
import { once } from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- `node-av` muxer output buffers in a Node stream
import { PassThrough, Readable } from "node:stream";

import { Data, Effect, Redacted, Schema, Stream } from "effect";
import { Log, avGetCodecName, avRescaleQ } from "node-av";
import type { CodecParameters, Packet, Stream as AvStream } from "node-av";
import { BitStreamFilterAPI, Decoder, Demuxer, Encoder, FilterAPI, Muxer } from "node-av/api";
import type { PipelineControl } from "node-av/api";
import {
  AVERROR_EPIPE,
  AV_CODEC_ID_AAC,
  AV_CODEC_ID_OPUS,
  AV_CODEC_PROP_LOSSLESS,
  AV_LOG_ERROR,
  AV_NOPTS_VALUE,
  FF_ENCODER_FLAC,
} from "node-av/constants";

// FFmpeg writes its log to stderr directly. Its warnings, such as the FLAC header that cannot be
// rewritten in a stream, are expected.
Log.setLevel(AV_LOG_ERROR);

export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
  /** A file path or the `name` of a `MediaStream` */
  input: Schema.String,
  reason: Schema.String,
}) {}

export class AudioFile extends Data.Class<{
  /** First FFmpeg name of the container format, for example `mov` for M4A */
  readonly container: string;
  readonly codec: string;
  readonly lossless: boolean;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitDepth: number | null;
  readonly bitrate: number | null;
  readonly durationMs: number;
  /** Lowercase keys. Ogg stores its tags on the stream, other containers on the file. */
  readonly tags: ReadonlyMap<string, string>;
  /** SHA-256 over the encoded audio packets, so that tag edits keep the same hash */
  readonly audioHash: string;
}> {}

// PCM codecs give their depth only as the coded size
const bitDepthOf = (parameters: CodecParameters) => {
  if (parameters.bitsPerRawSample > 0) return parameters.bitsPerRawSample;
  if (parameters.hasProperties(AV_CODEC_PROP_LOSSLESS) && parameters.bitsPerCodedSample > 0) {
    return parameters.bitsPerCodedSample;
  }
  return null;
};

/**
 * A byte stream for FFmpeg. The caller owns `bytes` and closes it after the media stream ends. A
 * media stream that stops early destroys `bytes`.
 */
export class MediaStream extends Data.Class<{
  /** Names the input in errors. A provider stream can come from a signed URL, so use an ID. */
  readonly name: string;
  readonly bytes: Readable;
  /** FFmpeg demuxer name, for example `mov` */
  readonly format: string;
  /** Demuxer options, for example the CENC `decryption_keys`. Redact secret values. */
  readonly options: Readonly<Record<string, string | Redacted.Redacted<string>>>;
  /** The bytes start inside the source, so the first packet does not give the start of the source */
  readonly partial?: boolean;
}> {}

const openAudio = (media: string | MediaStream) =>
  Effect.gen(function* () {
    const name = media instanceof MediaStream ? media.name : media;
    const input = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => {
          if (!(media instanceof MediaStream)) return Demuxer.open(media);

          const options = Object.fromEntries(
            Object.entries(media.options).map(([key, value]) => [
              key,
              Redacted.isRedacted(value) ? Redacted.value(value) : value,
            ]),
          );
          return Demuxer.open(media.bytes, { format: media.format, options });
        },
        catch: (cause) => new MediaError({ input: name, reason: String(cause) }),
      }),
      (input) => Effect.promise(() => input.close()),
    );
    const stream = input.audio();
    if (stream === undefined) {
      return yield* new MediaError({ input: name, reason: "No audio stream" });
    }
    const partial = media instanceof MediaStream && media.partial === true;
    return { input, stream, name, partial };
  });

export const readAudioFile = (path: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { input, stream } = yield* openAudio(path);
      const parameters = stream.codecpar;
      const tags = new Map(
        Object.entries({ ...input.metadata, ...stream.metadata?.getAll() }).map(
          ([key, value]) => [key.toLowerCase(), value] as const,
        ),
      );
      const hash = createHash("sha256");
      yield* Stream.fromAsyncIterable(
        input.packets(stream.index),
        (cause) => new MediaError({ input: path, reason: String(cause) }),
      ).pipe(
        // `null` marks the end of the packets
        Stream.takeWhile((packet) => packet !== null),
        Stream.runForEach((packet) =>
          Effect.sync(() => {
            if (packet.data !== null) hash.update(packet.data);
            packet.free();
          }),
        ),
      );
      const audioHash = hash.digest("hex");
      const bitrate = Number(parameters.bitRate);

      return new AudioFile({
        container: input.formatName.split(",")[0] ?? input.formatName,
        codec: avGetCodecName(parameters.codecId) ?? "unknown",
        lossless: parameters.hasProperties(AV_CODEC_PROP_LOSSLESS),
        sampleRate: parameters.sampleRate,
        channels: parameters.channels,
        bitDepth: bitDepthOf(parameters),
        bitrate: bitrate > 0 ? bitrate : null,
        durationMs: Math.round(input.duration * 1000),
        tags,
        audioHash,
      });
    }),
  );

// Writes the packets of one output stream and closes the muxer at the end of the input.
// `drained` waits until the reader of the output takes more bytes.
const writePackets = (
  output: Muxer,
  index: number,
  packets: AsyncIterable<Packet | null>,
  drained: () => Promise<void>,
) => {
  const stopped = new AbortController();
  // @effect-diagnostics-next-line asyncFunction:off -- `muxStream` closes the muxer only after the last native write returns, and an interrupted fiber does not wait for its promise
  const write = async () => {
    for await (const packet of packets) {
      if (stopped.signal.aborted) {
        packet?.free();
        break;
      }
      try {
        await drained();
        await output.writePacket(packet, index);
      } finally {
        packet?.free();
      }
    }
    await output.close();
  };
  return { stop: () => stopped.abort(), completion: write() };
};

// Finalizers run in reverse order: the producer stops, then the muxer closes, then the caller's
// decoder and input close. `writePackets` does not close the muxer when a write fails.
const muxStream = (
  media: string | MediaStream,
  muxer: { readonly format: string; readonly options?: Record<string, string> },
  run: (
    output: Muxer,
    drained: () => Promise<void>,
  ) => Pick<PipelineControl, "stop" | "completion">,
) =>
  Effect.gen(function* () {
    const name = media instanceof MediaStream ? media.name : media;
    const body = new PassThrough();
    // A native write holds a libuv worker until this callback returns, so it never waits for
    // `drain`. `writePackets` waits before each packet instead.
    const write = (buffer: Buffer) => {
      // `Muxer.close` writes the trailer after a failure or disconnect too
      if (body.destroyed) return AVERROR_EPIPE;
      // FFmpeg reuses the buffer after the callback returns
      body.write(Buffer.from(buffer));
      return buffer.length;
    };
    // Only an `error` event releases a wait for `drain`, see the finalizer below
    const drained = () =>
      body.writableNeedDrain ? once(body, "drain").then(() => {}) : Promise.resolve();
    const output = yield* Effect.acquireRelease(
      Effect.tryPromise({
        // One stream needs no interleaving. The sync queue that `node-av` 6.1.1 uses for stream
        // copy leaks the native `AVPacket` that `SyncQueue.send` clones for each packet.
        try: () => Muxer.open({ write }, { ...muxer, useSyncQueue: false }),
        catch: (cause) => new MediaError({ input: name, reason: String(cause) }),
      }),
      (output) => Effect.promise(() => output.close()),
    );
    const control = run(output, drained);
    control.completion.then(
      () => body.end(),
      (cause: unknown) => body.destroy(cause instanceof Error ? cause : new Error(String(cause))),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        control.stop();
        if (!body.destroyed) body.destroy(new Error("Playback closed"));
        // A native read that waits for bytes holds a libuv worker, and the pipeline completes only
        // after it returns. The end of the bytes returns it.
        if (media instanceof MediaStream) media.bytes.destroy();
        return control.completion.catch(() => undefined);
      }),
    );
    return Stream.fromReadableStream({
      // SAFETY: a `PassThrough` without an encoding gives `Buffer` chunks, which are `Uint8Array`
      evaluate: () => Readable.toWeb(body) as ReadableStream<Uint8Array>,
      onError: (cause) => new MediaError({ input: name, reason: String(cause) }),
      // The finalizer above stops the pipeline before it closes `body`. A cancel of the reader would
      // close `body` first, while the pipeline still writes to it.
      releaseLockOnEnd: true,
    });
  });

// Positions count from the first sample that a full decode gives. FFmpeg puts the start time of
// the stream after the encoder priming, for example the MP3 LAME delay or the MP4 edit list.
const startTimestamp = (stream: AvStream, startMs: number, partial: boolean) =>
  (stream.startTime === AV_NOPTS_VALUE || partial ? 0n : stream.startTime) +
  avRescaleQ(startMs, { num: 1, den: 1000 }, stream.timeBase);

// Lossy frames overlap the frame before them, and an MP3 frame can use 511 bytes of earlier frames.
// 1024 bytes of packets with their headers cover that; Opus needs 80 ms (RFC 7845, section 4.6).
const isEnoughPreroll = (stream: AvStream, packets: ReadonlyArray<Packet>) => {
  if (stream.codecpar.hasProperties(AV_CODEC_PROP_LOSSLESS)) return true;
  if (packets.length === 0) return false;

  const reservoirBytes = packets.slice(0, -1).reduce((sum, packet) => sum + packet.size, 0);
  const duration = packets.reduce((sum, packet) => sum + packet.duration, 0n);
  const opusPreroll = stream.codecpar.codecId === AV_CODEC_ID_OPUS ? 80 : 0;
  return (
    reservoirBytes >= 1024 &&
    duration >= avRescaleQ(opusPreroll, { num: 1, den: 1000 }, stream.timeBase)
  );
};

// The packet that contains `start`, the packets after it, and the packets before it that the
// decoder needs to decode it correctly
const packetsFrom = (name: string, input: Demuxer, stream: AvStream, start: bigint) =>
  Stream.fromAsyncIterable(
    input.packets(stream.index),
    (cause) => new MediaError({ input: name, reason: String(cause) }),
  ).pipe(
    Stream.mapAccum(
      () => Array.of<Packet>(),
      (preroll, packet) => {
        // The demuxer ends with `null`, so the preroll is always given to the consumer, which
        // frees it
        if (packet === null || packet.pts + packet.duration > start) {
          return [Array.of<Packet>(), [...preroll, packet]] as const;
        }

        const window = [...preroll, packet];
        while (window.length > 0 && isEnoughPreroll(stream, window.slice(1))) {
          window.shift()?.free();
        }
        return [window, Array.of<Packet | null>()] as const;
      },
    ),
  );

/**
 * Copies encoded audio into a streamable container without decoding or re-encoding. The output
 * starts `startMs` into the audio.
 */
export const remuxAudio = (media: string | MediaStream, container: string, startMs = 0) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { input, stream, name, partial } = yield* openAudio(media);
      const start = startTimestamp(stream, startMs, partial);
      // The preroll gets negative timestamps, which the MP4 edit list hides. MP3 and ADTS have no
      // edit list, so their output starts with the preroll.
      const packets = Stream.toAsyncIterable(
        packetsFrom(name, input, stream, start).pipe(
          Stream.tap((packet) =>
            Effect.sync(() => {
              if (packet === null) return;
              packet.pts -= start;
              packet.dts -= start;
            }),
          ),
        ),
      );
      // Fragmented MP4 needs no seek back to the header. `delay_moov` writes the header after the
      // first packets, when the AAC configuration from the filter below and the edit list are
      // known. `frag_duration` is in microseconds, so each fragment has 1 second of audio.
      const muxer =
        container === "mp4"
          ? {
              format: container,
              options: { movflags: "delay_moov+default_base_moof", frag_duration: "1000000" },
            }
          : { format: container };
      // Only the audio stream: cover art is a video stream that most audio containers reject.
      // MP4 stores the AAC configuration in its header, ADTS in each frame. `node-av` 6.1.1 does
      // not add this filter automatically. It passes MP4 input through unchanged.
      if (container === "mp4" && stream.codecpar.codecId === AV_CODEC_ID_AAC) {
        const filter = yield* Effect.acquireRelease(
          Effect.try({
            try: () => BitStreamFilterAPI.create("aac_adtstoasc", stream),
            catch: (cause) => new MediaError({ input: name, reason: String(cause) }),
          }),
          (filter) => Effect.sync(() => filter.close()),
        );
        return yield* muxStream(media, muxer, (output, drained) =>
          writePackets(
            output,
            output.addStream(stream, { bsf: filter }),
            filter.packets(packets),
            drained,
          ),
        );
      }

      return yield* muxStream(media, muxer, (output, drained) =>
        writePackets(output, output.addStream(stream), packets, drained),
      );
    }),
  );

/**
 * Decodes any audio file and encodes it as a FLAC stream. The output starts exactly `startMs`
 * into the audio.
 */
export const encodeFlac = (media: string | MediaStream, startMs = 0) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { input, stream, name, partial } = yield* openAudio(media);
      const fail = (cause: unknown) => new MediaError({ input: name, reason: String(cause) });
      const start = startTimestamp(stream, startMs, partial);
      // Decoding starts at the preroll before `start`, and `atrim` drops the decoded samples
      // before it. Audio filters count time in samples.
      const startSample = avRescaleQ(start, stream.timeBase, {
        num: 1,
        den: stream.codecpar.sampleRate,
      });
      // Lossy decoders give float samples; 16 bits keep their quality at a smaller size
      const sampleFormat = (bitDepthOf(stream.codecpar) ?? 16) > 16 ? "s32" : "s16";
      const decoder = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => Decoder.create(stream), catch: fail }),
        (decoder) => Effect.sync(() => decoder.close()),
      );
      const filter = yield* Effect.acquireRelease(
        Effect.sync(() =>
          FilterAPI.create(`atrim=start_pts=${startSample},aformat=sample_fmts=${sampleFormat}`),
        ),
        (filter) => Effect.sync(() => filter.close()),
      );
      const encoder = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Encoder.create(FF_ENCODER_FLAC, { decoder }),
          catch: fail,
        }),
        (encoder) => Effect.sync(() => encoder.close()),
      );
      // `patches/node-av@6.1.1.patch` makes the flush encode the last partial frame, which
      // `node-av` 6.1.1 drops
      const packets = encoder.packets(
        filter.frames(
          decoder.frames(Stream.toAsyncIterable(packetsFrom(name, input, stream, start))),
        ),
      );
      return yield* muxStream(media, { format: "flac" }, (output, drained) =>
        writePackets(output, output.addStream(stream, { encoder }), packets, drained),
      );
    }),
  );

export { bitDepthOf, muxStream, openAudio, packetsFrom, startTimestamp, writePackets };
export { AudioMeasurement, measureAudio } from "./audio-analysis.ts";
export { BeatAnalysis, BeatWindow } from "./beat-analysis.ts";
