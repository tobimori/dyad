import { Data } from "effect";

/** Loudness of one source, as EBU R128 measures it */
export class Loudness extends Data.Class<{
  /** Integrated loudness in LUFS */
  readonly integrated: number;
  /** True peak in dBTP */
  readonly truePeak: number;
}> {}

const targetLufs = -18;
const truePeakCeiling = -1;

// A typical modern master is about -10 LUFS
const unanalyzedGainDb = -8;

/** One constant gain for the whole source: no compression and no limiter */
export const loudnessGain = (loudness: Loudness | undefined) => {
  const db =
    loudness === undefined
      ? unanalyzedGainDb
      : Math.min(targetLufs - loudness.integrated, truePeakCeiling - loudness.truePeak);
  return 10 ** (db / 20);
};
