import { Data, Effect, Stream } from "effect";
import { Decoder, FilterAPI } from "node-av/api";

import { MediaError, openAudio } from "./node.ts";
import type { MediaStream } from "./node.ts";

/** Loudness and silence of the full decoded audio */
export class AudioMeasurement extends Data.Class<{
  /** Integrated loudness in LUFS (EBU R128) */
  readonly loudness: number;
  /** In dBTP */
  readonly truePeak: number;
  /** Time before the first sample above −60 dBFS */
  readonly leadingSilenceMs: number;
  /** Time after the last sample above −60 dBFS */
  readonly trailingSilenceMs: number;
}> {}

const silenceThreshold = 10 ** (-60 / 20);

// The `ebur128` true peak rate. Its frame metadata gives a lower true peak than its summary
// (FFmpeg 8.1), so `astats` measures the peak after our own resampling.
const truePeakRate = 192_000;

const graph = [
  "ebur128=metadata=1",
  `aresample=${truePeakRate}`,
  "astats=metadata=1:reset=0:measure_perchannel=none:measure_overall=Peak_level",
  "aformat=sample_fmts=dbl",
].join(",");

/** Decodes the whole audio. Fails for audio with no sample above the silence threshold. */
export const measureAudio = (media: string | MediaStream) =>
  Effect.scoped(
    Effect.gen(function* () {
      const { input, stream, name } = yield* openAudio(media);
      const fail = (cause: unknown) => new MediaError({ input: name, reason: String(cause) });
      const decoder = yield* Effect.acquireRelease(
        Effect.tryPromise({ try: () => Decoder.create(stream), catch: fail }),
        (decoder) => Effect.sync(() => decoder.close()),
      );
      const filter = yield* Effect.acquireRelease(
        Effect.try({ try: () => FilterAPI.create(graph), catch: fail }),
        (filter) => Effect.sync(() => filter.close()),
      );

      // Positions are in samples at `truePeakRate`
      const result = yield* Stream.fromAsyncIterable(
        filter.frames(decoder.frames(input.packets(stream.index))),
        fail,
      ).pipe(
        Stream.takeWhile((frame) => frame !== null),
        Stream.runFold(
          () => ({
            loudness: Number.NaN,
            truePeak: Number.NaN,
            length: 0,
            firstSound: -1,
            soundEnd: -1,
          }),
          (state, frame) => {
            const metadata = frame.getMetadata();
            // `aformat` gives packed samples in one plane
            const buffer = frame.data?.[0];
            const samples =
              buffer === undefined
                ? new Float64Array()
                : new Float64Array(buffer.buffer, buffer.byteOffset, buffer.length / 8);
            const channels = samples.length / frame.nbSamples;
            const isSound = (sample: number) => Math.abs(sample) > silenceThreshold;
            const last = samples.findLastIndex(isSound);
            const first =
              state.firstSound >= 0 || last < 0
                ? state.firstSound
                : state.length + Math.floor(samples.findIndex(isSound) / channels);

            const next = {
              loudness: Number(metadata.get("lavfi.r128.I") ?? state.loudness),
              truePeak: Number(metadata.get("lavfi.astats.Overall.Peak_level") ?? state.truePeak),
              length: state.length + frame.nbSamples,
              firstSound: first,
              soundEnd: last < 0 ? state.soundEnd : state.length + Math.floor(last / channels) + 1,
            };
            frame.free();
            return next;
          },
        ),
      );

      if (result.firstSound < 0 || !Number.isFinite(result.loudness)) {
        return yield* new MediaError({ input: name, reason: "No sound" });
      }
      return new AudioMeasurement({
        loudness: result.loudness,
        truePeak: result.truePeak,
        leadingSilenceMs: Math.round((result.firstSound / truePeakRate) * 1000),
        trailingSilenceMs: Math.round(((result.length - result.soundEnd) / truePeakRate) * 1000),
      });
    }),
  );
