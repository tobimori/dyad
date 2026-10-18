import { Data, Effect, Stream } from "effect";
import { Decoder, FilterAPI } from "node-av/api";

import { beatSampleRate, collectBeatAudio } from "./beat-analysis.ts";
import type { BeatAnalysis } from "./beat-analysis.ts";
import { MediaError, openAudio } from "./node.ts";
import type { MediaStream } from "./node.ts";

/** Loudness, silence and beats of the full decoded audio */
export class AudioMeasurement extends Data.Class<{
  /** Integrated loudness in LUFS (EBU R128) */
  readonly loudness: number;
  /** In dBTP */
  readonly truePeak: number;
  /** Time before the first sample above −60 dBFS */
  readonly leadingSilenceMs: number;
  /** Time after the last sample above −60 dBFS */
  readonly trailingSilenceMs: number;
  /** `undefined` for less than 8 s of sound */
  readonly beats: BeatAnalysis | undefined;
}> {}

const silenceThreshold = 10 ** (-60 / 20);

// The `ebur128` true peak rate. Its frame metadata gives a lower true peak than its summary
// (FFmpeg 8.1), so `astats` measures the peak of each frame after our own resampling.
const truePeakRate = 192_000;

const graph = [
  "ebur128=metadata=1",
  `aresample=${truePeakRate}`,
  "astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=Peak_level",
  `aresample=${beatSampleRate}`,
  "aformat=sample_fmts=flt:channel_layouts=stereo",
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

      const beats = collectBeatAudio();
      // Positions are in frames at `beatSampleRate`
      const result = yield* Stream.fromAsyncIterable(
        filter.frames(decoder.frames(input.packets(stream.index))),
        fail,
      ).pipe(
        Stream.takeWhile((frame) => frame !== null),
        Stream.runFold(
          () => ({
            loudness: Number.NaN,
            truePeak: Number.NEGATIVE_INFINITY,
            length: 0,
            firstSound: -1,
            soundEnd: -1,
          }),
          (state, frame) => {
            const metadata = frame.getMetadata();
            // `aformat` gives packed stereo samples in one plane
            const buffer = frame.data?.[0];
            const samples =
              buffer === undefined
                ? new Float32Array()
                : new Float32Array(buffer.buffer, buffer.byteOffset, buffer.length / 4);
            const channels = 2;
            // `astats` gives `-inf` for digital silence, and the last frame has no value
            const level = Number(metadata.get("lavfi.astats.Overall.Peak_level") ?? Number.NaN);
            const framePeak = Number.isNaN(level) ? Number.NEGATIVE_INFINITY : level;
            beats.push(samples, framePeak);
            const isSound = (sample: number) => Math.abs(sample) > silenceThreshold;
            const last = samples.findLastIndex(isSound);
            const first =
              state.firstSound >= 0 || last < 0
                ? state.firstSound
                : state.length + Math.floor(samples.findIndex(isSound) / channels);

            const next = {
              loudness: Number(metadata.get("lavfi.r128.I") ?? state.loudness),
              truePeak: Math.max(state.truePeak, framePeak),
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
        leadingSilenceMs: Math.round((result.firstSound / beatSampleRate) * 1000),
        trailingSilenceMs: Math.round(((result.length - result.soundEnd) / beatSampleRate) * 1000),
        beats: yield* beats.analyze(
          result.firstSound / beatSampleRate,
          result.soundEnd / beatSampleRate,
        ),
      });
    }),
  );
