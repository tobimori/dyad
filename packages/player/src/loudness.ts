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
// Near-silent sources, such as a hidden track, would otherwise get up to +52 dB
const maxGainDb = 12;

// A typical modern master is about -10 LUFS
const unanalyzedGainDb = -8;

// Loud lossy masters reach about +2 dBTP
const unanalyzedTruePeak = 2;

/** The true peak ceiling as a linear sample value */
export const peakCeiling = 10 ** (truePeakCeiling / 20);

/** One constant gain for the whole source and the true peak after it, with no limiter */
export const entryLevel = (loudness: Loudness | undefined) => {
  const truePeak = loudness?.truePeak ?? unanalyzedTruePeak;
  const db =
    loudness === undefined
      ? unanalyzedGainDb
      : Math.min(targetLufs - loudness.integrated, truePeakCeiling - truePeak, maxGainDb);
  return { gain: 10 ** (db / 20), peak: 10 ** ((truePeak + db) / 20) };
};
