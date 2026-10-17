// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebCrypto cannot hash a stream incrementally
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- `node-av` writes muxer output to a Node `Writable`
import { PassThrough, Readable } from "node:stream";

import { Data, Effect, Schema, Stream } from "effect";
import { Log, avGetCodecName } from "node-av";
import type { CodecParameters } from "node-av";
import { Decoder, Demuxer, Encoder, FilterAPI, Muxer, pipeline } from "node-av/api";
import { AV_CODEC_PROP_LOSSLESS, AV_LOG_ERROR, FF_ENCODER_FLAC } from "node-av/constants";

// FFmpeg writes its log to stderr directly. Its warnings, such as the FLAC header that cannot be
// rewritten in a stream, are expected.
Log.setLevel(AV_LOG_ERROR);

export class MediaError extends Schema.TaggedError<MediaError>()("MediaError", {
  path: Schema.String,
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

const openAudio = (path: string) =>
  Effect.gen(function* () {
    const input = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => Demuxer.open(path),
        catch: (cause) => new MediaError({ path, reason: String(cause) }),
      }),
      (input) => Effect.promise(() => input.close()),
    );
    const stream = input.audio();
    if (stream === undefined) {
      return yield* new MediaError({ path, reason: "No audio stream" });
    }
    return { input, stream };
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
        (cause) => new MediaError({ path, reason: String(cause) }),
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

/** Decodes any audio file and encodes it as a FLAC stream */
export const encodeFlac = (path: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const { input, stream } = yield* openAudio(path);
      const fail = (cause: unknown) => new MediaError({ path, reason: String(cause) });
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
      const body = new PassThrough();
      const output = yield* Effect.tryPromise({
        try: () => Muxer.open(body, { format: "flac" }),
        catch: fail,
      });
      const control = pipeline(input, decoder, filter, encoder, output);
      control.completion.then(
        () => body.end(),
        (cause: unknown) => body.destroy(cause instanceof Error ? cause : new Error(String(cause))),
      );
      // Runs when the client disconnects before the end
      yield* Effect.addFinalizer(() =>
        Effect.promise(() => {
          control.stop();
          return control.completion.catch(() => undefined);
        }),
      );

      return Stream.fromReadableStream({
        // SAFETY: a `PassThrough` without an encoding gives `Buffer` chunks, which are `Uint8Array`
        evaluate: () => Readable.toWeb(body) as ReadableStream<Uint8Array>,
        onError: fail,
      });
    }),
  );
