import { FLACDecoder } from "@wasm-audio-decoders/flac";
import { Data, Effect } from "effect";
import { MPEGDecoder } from "mpg123-decoder";

export class DecodeError extends Data.TaggedError("DecodeError")<{ readonly cause: unknown }> {}

/** Float PCM of one decode step, one array per channel */
export class Pcm extends Data.Class<{
  readonly channels: ReadonlyArray<Float32Array>;
  readonly frames: number;
  /** 0 until the decoder has read the first frame header */
  readonly sampleRate: number;
}> {}

/** Decodes one FLAC or MP3 byte stream. Chunks can split frames at any byte. */
export class Decoder extends Data.Class<{
  readonly decode: (bytes: Uint8Array) => Effect.Effect<Pcm, DecodeError>;
  /** Decodes the frames that the decoder still holds at the end of the stream */
  readonly flush: Effect.Effect<Pcm, DecodeError>;
  /** Forgets all input, for example before the bytes of a seek point */
  readonly reset: Effect.Effect<void, DecodeError>;
}> {}

const toPcm = (decoded: {
  readonly channelData: ReadonlyArray<Float32Array>;
  readonly samplesDecoded: number;
  readonly sampleRate: number;
}) =>
  new Pcm({
    channels: decoded.channelData,
    frames: decoded.samplesDecoded,
    sampleRate: decoded.sampleRate,
  });

const noPcm = new Pcm({ channels: [], frames: 0, sampleRate: 0 });

const flacDecoder = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => {
      const decoder = new FLACDecoder();
      return decoder.ready.then(() => decoder);
    },
    catch: (cause) => new DecodeError({ cause }),
  }),
  (decoder) => Effect.sync(() => decoder.free()),
).pipe(
  Effect.map(
    (decoder) =>
      new Decoder({
        decode: (bytes) =>
          Effect.tryPromise({
            try: () => decoder.decode(bytes),
            catch: (cause) => new DecodeError({ cause }),
          }).pipe(Effect.map(toPcm)),
        flush: Effect.tryPromise({
          try: () => decoder.flush(),
          catch: (cause) => new DecodeError({ cause }),
        }).pipe(Effect.map(toPcm)),
        reset: Effect.tryPromise({
          try: () => decoder.reset(),
          catch: (cause) => new DecodeError({ cause }),
        }),
      }),
  ),
);

// mpg123 keeps no frames back, so a flush has nothing to decode
const mp3Decoder = Effect.acquireRelease(
  Effect.tryPromise({
    try: () => {
      const decoder = new MPEGDecoder();
      return decoder.ready.then(() => decoder);
    },
    catch: (cause) => new DecodeError({ cause }),
  }),
  (decoder) => Effect.sync(() => decoder.free()),
).pipe(
  Effect.map(
    (decoder) =>
      new Decoder({
        decode: (bytes) =>
          Effect.try({
            try: () => toPcm(decoder.decode(bytes)),
            catch: (cause) => new DecodeError({ cause }),
          }),
        flush: Effect.succeed(noPcm),
        reset: Effect.tryPromise({
          try: () => decoder.reset(),
          catch: (cause) => new DecodeError({ cause }),
        }),
      }),
  ),
);

/** A streaming decoder that lives until the scope closes */
export const makeDecoder = (codec: "flac" | "mp3") => (codec === "flac" ? flacDecoder : mp3Decoder);
