// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto cannot hash a stream incrementally
import { createHash } from "node:crypto";
import { once } from "node:events";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- `node-av` muxer output buffers in a Node stream
import { PassThrough, Readable } from "node:stream";

import { Data, Effect, Redacted, Schema, Stream } from "effect";
import { Log, avGetCodecName } from "node-av";
import type { CodecParameters } from "node-av";
import {
  BitStreamFilterAPI,
  Decoder,
  Demuxer,
  Encoder,
  FilterAPI,
  Muxer,
  pipeline,
} from "node-av/api";
import type { PipelineControl } from "node-av/api";
import {
  AVERROR_EPIPE,
  AV_CODEC_ID_AAC,
  AV_CODEC_PROP_LOSSLESS,
  AV_LOG_ERROR,
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

/** A byte stream for FFmpeg. The caller owns `bytes` and closes it after the media stream ends. */
export class MediaStream extends Data.Class<{
  /** Names the input in errors. A provider stream can come from a signed URL, so use an ID. */
  readonly name: string;
  readonly bytes: Readable;
  /** FFmpeg demuxer name, for example `mov` */
  readonly format: string;
  /** Demuxer options, for example the CENC `decryption_keys`. Redact secret values. */
  readonly options: Readonly<Record<string, string | Redacted.Redacted<string>>>;
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
    return { input, stream, name };
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

// Finalizers run in reverse order: the producer stops, then the muxer closes, then the caller's
// decoder and input close. `node-av` 6.1.1 closes the muxer only after a successful pipeline.
const muxStream = (
  name: string,
  muxer: { readonly format: string; readonly options?: Record<string, string> },
  run: (output: Muxer) => PipelineControl,
) =>
  Effect.gen(function* () {
    const body = new PassThrough();
    const write = (buffer: Buffer) => {
      // `node-av` 6.1.1 waits for `drain` forever on a destroyed `Writable`, so the trailer that
      // `Muxer.close` writes after a failure or disconnect would block the close
      if (body.destroyed) return AVERROR_EPIPE;
      // FFmpeg reuses the buffer after the callback returns
      if (body.write(Buffer.from(buffer))) return buffer.length;
      return once(body, "drain").then(() => buffer.length);
    };
    const output = yield* Effect.acquireRelease(
      Effect.tryPromise({
        // One stream needs no interleaving. The sync queue that `node-av` 6.1.1 uses for stream
        // copy leaks the native `AVPacket` that `SyncQueue.send` clones for each packet.
        try: () => Muxer.open({ write }, { ...muxer, useSyncQueue: false }),
        catch: (cause) => new MediaError({ input: name, reason: String(cause) }),
      }),
      (output) => Effect.promise(() => output.close()),
    );
    const control = run(output);
    control.completion.then(
      () => body.end(),
      (cause: unknown) => body.destroy(cause instanceof Error ? cause : new Error(String(cause))),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(() => {
        control.stop();
        // Only an `error` event releases a write that waits for `drain`
        if (!body.destroyed) body.destroy(new Error("Playback closed"));
        return control.completion.catch(() => undefined);
      }),
    );
    return Stream.fromReadableStream({
      // SAFETY: a `PassThrough` without an encoding gives `Buffer` chunks, which are `Uint8Array`
      evaluate: () => Readable.toWeb(body) as ReadableStream<Uint8Array>,
      onError: (cause) => new MediaError({ input: name, reason: String(cause) }),
      // The pipeline finalizer closes the producer before awaiting its completion
      releaseLockOnEnd: true,
    });
  });

/** Copies encoded audio into a streamable container without decoding or re-encoding */
export const remuxAudio = (media: string | MediaStream, container: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { input, stream, name } = yield* openAudio(media);
      // Fragmented MP4 needs no seek back to the header. `delay_moov` writes the header after the
      // first packets, when the AAC configuration from the filter below is known.
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
        return yield* muxStream(name, muxer, (output) =>
          pipeline(input, { audio: [filter] }, output),
        );
      }

      return yield* muxStream(name, muxer, (output) =>
        pipeline(input, { audio: "passthrough" }, output),
      );
    }),
  );

/** Decodes any audio file and encodes it as a FLAC stream */
export const encodeFlac = (media: string | MediaStream) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { input, stream, name } = yield* openAudio(media);
      const fail = (cause: unknown) => new MediaError({ input: name, reason: String(cause) });
      // Lossy decoders give float samples; 16 bits keep their quality at a smaller size
      const sampleFormat = (bitDepthOf(stream.codecpar) ?? 16) > 16 ? "s32" : "s16";
      const decoder = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => Decoder.create(stream), catch: fail }),
        (decoder) => Effect.sync(() => decoder.close()),
      );
      const filter = yield* Effect.acquireRelease(
        Effect.sync(() => FilterAPI.create(`aformat=sample_fmts=${sampleFormat}`)),
        (filter) => Effect.sync(() => filter.close()),
      );
      const encoder = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => Encoder.create(FF_ENCODER_FLAC, { decoder }),
          catch: fail,
        }),
        (encoder) => Effect.sync(() => encoder.close()),
      );
      return yield* muxStream(name, { format: "flac" }, (output) =>
        pipeline(input, decoder, filter, encoder, output),
      );
    }),
  );
