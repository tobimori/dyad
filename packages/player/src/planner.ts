import { Data } from "effect";

/** A constant beat grid that fits one window of a source */
export class BeatGrid extends Data.Class<{
  readonly bpm: number;
  /** Source time of one beat in seconds. A bar starts on it if `downbeatConfidence` is high. */
  readonly beat: number;
  /** Estimated probability that `beat` is on the beat, not on the off-beat */
  readonly confidence: number;
  /** Estimated probability that a bar starts on `beat` */
  readonly downbeatConfidence: number;
  /** Source time of the bar of `truePeaks[0]`. Bars are 4 beats and start on `beat`. */
  readonly peaksFrom?: number | undefined;
  /** True peak of each bar in dBTP. Without it, the true peak bound uses the source's true peak. */
  readonly truePeaks?: ReadonlyArray<number> | undefined;
}> {}

/** A position on the Camelot wheel */
export class Camelot extends Data.Class<{
  /** 1 to 12 */
  readonly number: number;
  readonly minor: boolean;
}> {}

/** Beat analysis of one source for DJ transitions. Times are source seconds. */
export class DjAnalysis extends Data.Class<{
  /** Grid of the first 60 s of sound */
  readonly intro: BeatGrid;
  /** Grid of the last 60 s of sound */
  readonly outro: BeatGrid;
  /** The first sound */
  readonly start: number;
  /** The end of the last sound */
  readonly end: number;
  readonly introEnd: number;
  readonly outroStart: number;
  /** About half of the detected keys are wrong, so a clash only shortens an overlap */
  readonly key: Camelot | undefined;
}> {}

export const djStyles = ["blend", "filter", "echo-out", "rise"] as const;

export type DjStyle = (typeof djStyles)[number];

/** A beat-matched overlap of A and B. B plays at A's tempo through a stretcher. */
export class Transition extends Data.Class<{
  readonly style: DjStyle;
  /** Source time of A where the overlap starts */
  readonly out: number;
  /** Source time of B that plays at `out` */
  readonly in: number;
  readonly beats: number;
  /** Seconds per beat in the overlap, which is A's tempo */
  readonly beat: number;
  /** Source seconds of B per second in the overlap */
  readonly rate: number;
  /** After the overlap, B goes back to its own tempo over these beats */
  readonly rampBeats: number;
  /** The overlap starts on a bar of both, so a style can act on downbeats */
  readonly downbeats: boolean;
}> {}

/** Largest tempo change of B, as a fraction */
export const defaultMaxTempoChange = 0.06;

// Octave errors pass this gate, so half and double tempo matches are not used
const gridGate = 0.85;
const downbeatGate = 0.8;
const phraseBeats = 32;

const styleBars = { blend: 16, filter: 16, "echo-out": 8, rise: 16 };

// More than one step apart on the wheel, and not relative major or minor
const keysClash = (a: Camelot | undefined, b: Camelot | undefined) => {
  if (a === undefined || b === undefined || a.number === b.number) return false;
  const steps = Math.abs(a.number - b.number);
  return a.minor !== b.minor || Math.min(steps, 12 - steps) > 1;
};

/** Plans a beat-matched transition, or gives `undefined` for a plain crossfade */
export const planTransition = (
  a: DjAnalysis,
  b: DjAnalysis,
  style: DjStyle,
  maxTempoChange = defaultMaxTempoChange,
) => {
  const from = a.outro;
  const to = b.intro;
  const rate = from.bpm / to.bpm;
  if (from.confidence < gridGate || to.confidence < gridGate) return undefined;
  if (Math.abs(rate - 1) > maxTempoChange) return undefined;

  const downbeats =
    from.downbeatConfidence >= downbeatGate && to.downbeatConfidence >= downbeatGate;
  const beat = 60 / from.bpm;
  const inBeat = 60 / to.bpm;

  // B comes in on its first bar, or beat, of sound
  const inStep = (downbeats ? 4 : 1) * inBeat;
  const mixIn = to.beat + Math.ceil((b.start - to.beat) / inStep - 1e-9) * inStep;

  // 8 to 32 bars, limited by the style, a key clash and the intro and outro lengths
  const longest = Math.min(
    styleBars[style] / (keysClash(a.key, b.key) ? 2 : 1),
    (a.end - a.outroStart) / (4 * beat),
    (b.introEnd - mixIn) / (4 * inBeat),
  );
  const beats = 4 * ([32, 16].find((bars) => bars <= longest) ?? 8);

  // A's last phrase, or beat, with room for the overlap before its sound ends
  const outStep = (downbeats ? phraseBeats : 1) * beat;
  const mixOut = from.beat + Math.floor((a.end - beats * beat - from.beat) / outStep) * outStep;
  if (mixOut < a.start || mixIn + beats * inBeat > b.end) return undefined;

  return new Transition({
    style,
    out: mixOut,
    in: mixIn,
    beats,
    beat,
    rate,
    rampBeats: 32,
    downbeats,
  });
};
