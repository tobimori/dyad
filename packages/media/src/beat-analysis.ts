import { Effect, Schema } from "effect";

/** Beat grid of one 60 s window of a source, on the kick attacks */
export class BeatWindow extends Schema.Class<BeatWindow>("BeatWindow")({
  bpm: Schema.Finite,
  /** Source seconds of a beat on the kick attack. A bar starts on it if `downbeatConfidence` is high. */
  beat: Schema.Finite,
  /** Estimated probability that the grid is on the beat, not on the off-beat, within 10 ms */
  confidence: Schema.Finite,
  /** Estimated probability that a bar starts on `beat` */
  downbeatConfidence: Schema.Finite,
  /** Source seconds of the bar of `truePeaks[0]`. Bars are 4 beats long and start on `beat`. */
  peaksFrom: Schema.Finite,
  /** True peak of each bar of the window in dBTP */
  truePeaks: Schema.Array(Schema.Finite),
}) {}

/** Beat analysis for DJ transitions. Times are source seconds. */
export class BeatAnalysis extends Schema.Class<BeatAnalysis>("BeatAnalysis")({
  /** The first 60 s of sound */
  intro: BeatWindow,
  /** The last 60 s of sound */
  outro: BeatWindow,
  /** The first sample above −60 dBFS */
  start: Schema.Finite,
  /** The end of the last sample above −60 dBFS */
  end: Schema.Finite,
  /** The first bar at the main level, at most 60 s after `start` */
  introEnd: Schema.Finite,
  /** The end of the last bar at the main level, at most 60 s before `end` */
  outroStart: Schema.Finite,
  /** Camelot key of the intro and outro together. About half of these keys are wrong. */
  key: Schema.NullOr(Schema.Struct({ number: Schema.Int, minor: Schema.Boolean })),
}) {}

// oxlint-disable-next-line @project/no-shape-declarations -- the parts of the essentia.js 0.1.3 WASM module that this file uses
interface Essentia {
  readonly EssentiaJS: new (debug: boolean) => {
    RhythmExtractor2013(
      signal: EssentiaVector,
      maxTempo: number,
      method: "degara",
      minTempo: number,
    ): {
      readonly bpm: number;
      readonly ticks: EssentiaVector;
      readonly estimates: EssentiaVector;
      readonly bpmIntervals: EssentiaVector;
    };
    KeyExtractor(
      audio: EssentiaVector,
      averageDetuningCorrection: boolean,
      frameSize: number,
      hopSize: number,
      hpcpSize: number,
      maxFrequency: number,
      maximumSpectralPeaks: number,
      minFrequency: number,
      pcpThreshold: number,
      profileType: "bgate",
      sampleRate: number,
      spectralPeaksThreshold: number,
      tuningFrequency: number,
      weightType: "cosine",
      windowType: "hann",
    ): { readonly key: string; readonly scale: string };
  };
  arrayToVector(array: Float32Array): EssentiaVector;
  vectorToArray(vector: EssentiaVector): Float32Array;
}

// oxlint-disable-next-line @project/no-shape-declarations -- an Emscripten vector of essentia.js 0.1.3 that `delete` frees
interface EssentiaVector {
  delete(): void;
}

let essentia: Promise<Essentia> | undefined;

// essentia.js 0.1.3: the ES build reads `__dirname`, so only the UMD build loads in Node
const loadEssentia = () => {
  // @ts-expect-error -- essentia.js 0.1.3 has no types
  essentia ??= import("essentia.js/dist/essentia-wasm.umd.js").then((module) => module.default);
  return essentia;
};

/** Sample rate of the audio that `collectBeatAudio` takes */
export const beatSampleRate = 44_100;
const rate = beatSampleRate;
const windowSeconds = 60;
// Essentia's beat tracker gets this much audio around a window for its tempo and warm-up
const contextSeconds = 120;
// Room for silence before the intro context and after the outro context
const spareSeconds = 10;

/**
 * Collects mono audio of the first and last `contextSeconds`, levels per second and true peaks per
 * frame while a source decodes, then analyzes them
 */
export const collectBeatAudio = () => {
  const head = new Float32Array((contextSeconds + spareSeconds) * rate);
  const tail = new Float32Array((contextSeconds + spareSeconds) * rate);
  const levels: Array<number> = [];
  const peakFrames: Array<number> = [];
  const peakValues: Array<number> = [];
  let frames = 0;
  let squares = 0;

  /** Interleaved stereo frames and their true peak in dBTP */
  const push = (stereo: Float32Array, truePeak: number) => {
    peakFrames.push(frames);
    peakValues.push(truePeak);
    for (let index = 0; index < stereo.length / 2; index++) {
      const sample = ((stereo[2 * index] ?? 0) + (stereo[2 * index + 1] ?? 0)) / 2;
      if (frames < head.length) head[frames] = sample;
      tail[frames % tail.length] = sample;
      squares += sample * sample;
      frames++;
      if (frames % rate === 0) {
        levels.push(squares / rate);
        squares = 0;
      }
    }
  };

  // Audio of [from, to) seconds. Frames that the head and the tail do not hold are zero.
  const audio = (from: number, to: number) => {
    const first = Math.max(0, Math.round(from * rate));
    const out = new Float32Array(Math.max(0, Math.min(frames, Math.round(to * rate)) - first));
    for (let index = 0; index < out.length; index++) {
      const frame = first + index;
      if (frame < head.length) out[index] = head[frame] ?? 0;
      else if (frame >= frames - tail.length) out[index] = tail[frame % tail.length] ?? 0;
    }
    return out;
  };

  const peakOf = (from: number, to: number) => {
    let peak = Number.NEGATIVE_INFINITY;
    peakFrames.forEach((frame, index) => {
      const next = peakFrames[index + 1] ?? frames;
      if (next > from * rate && frame < to * rate) peak = Math.max(peak, peakValues[index] ?? peak);
    });
    return peak;
  };

  /** Analyzes the collected audio. Gives `undefined` for less than 8 s of sound. */
  const analyze = Effect.fnUntraced(function* (start: number, end: number) {
    if (end - start < 8) return undefined;
    const module = yield* Effect.promise(loadEssentia);
    const algorithms = new module.EssentiaJS(false);
    const seconds = levels.slice(Math.floor(start), Math.floor(end)).map(decibels);
    const main = seconds.toSorted((a, b) => a - b)[Math.floor(seconds.length * 0.75)] ?? 0;

    const analyzeWindow = Effect.fnUntraced(function* (
      from: number,
      to: number,
      contextFrom: number,
      contextTo: number,
    ) {
      const context = audio(contextFrom, contextTo);
      const signal = module.arrayToVector(context);
      const rhythm = algorithms.RhythmExtractor2013(signal, 208, "degara", 40);
      const ticks = [...module.vectorToArray(rhythm.ticks)].map((tick) => tick + contextFrom);
      for (const vector of [signal, rhythm.ticks, rhythm.estimates, rhythm.bpmIntervals]) {
        vector.delete();
      }
      // Lets I/O run between the long steps
      yield* Effect.yieldNow;

      const margin = Math.max(0, from - 1);
      const pcm = audio(margin, to + 1);
      const envelope = lowEnvelope(pcm, margin);
      const prior = tickGrid(
        ticks.filter((tick) => tick >= from && tick < to),
        rhythm.bpm,
      );
      const grid = kickGrid(envelope, prior, from, to);
      yield* Effect.yieldNow;

      const bars = downbeat(pcm, margin, envelope, grid, from, to);
      const bar = 4 * grid.period;
      const peaksFrom = bars.beat + Math.floor((from - bars.beat) / bar) * bar;
      const truePeaks: Array<number> = [];
      for (let at = peaksFrom; at < to; at += bar) {
        // Rounded up to stay a bound. A bar of digital silence has no finite peak.
        truePeaks.push(Math.max(-100, Math.ceil(peakOf(at, at + bar) * 100) / 100));
      }
      const barLevels: Array<number> = [];
      const firstBar = peaksFrom < from - 1e-6 ? peaksFrom + bar : peaksFrom;
      for (let at = firstBar; at + bar <= to + 1e-6; at += bar) {
        barLevels.push(decibels(meanSquare(pcm, at - margin, at + bar - margin)));
      }
      yield* Effect.yieldNow;
      return {
        window: new BeatWindow({
          bpm: 60 / grid.period,
          beat: bars.beat,
          confidence: grid.confidence,
          downbeatConfidence: bars.confidence,
          peaksFrom,
          truePeaks,
        }),
        firstBar,
        barLevels,
        bar,
      };
    });

    const intro = yield* analyzeWindow(
      start,
      Math.min(end, start + windowSeconds),
      start,
      Math.min(end, start + contextSeconds),
    );
    const outro = yield* analyzeWindow(
      Math.max(start, end - windowSeconds),
      end,
      Math.max(start, end - contextSeconds),
      end,
    );

    // The first and the last 8-bar block within 3 dB of the main level
    const full = (bars: ReadonlyArray<number>) =>
      bars.reduce((sum, level) => sum + level, 0) / bars.length >= main - 3;
    const introBlock = Array.from(
      { length: Math.floor(intro.barLevels.length / 8) },
      (_, block) => block * 8,
    ).find((first) => full(intro.barLevels.slice(first, first + 8)));
    const outroBlocks = Math.floor(outro.barLevels.length / 8);
    const outroBlock = Array.from(
      { length: outroBlocks },
      (_, block) => outro.barLevels.length - block * 8,
    ).find((last) => full(outro.barLevels.slice(last - 8, last)));
    const outroBars = outro.barLevels.length - (outroBlock ?? outro.barLevels.length);
    const outroEnd = outro.firstBar + outro.barLevels.length * outro.bar;

    const introAudio = audio(start, Math.min(end, start + windowSeconds));
    const outroAudio = audio(Math.max(start + windowSeconds, end - windowSeconds), end);
    const keyAudio = new Float32Array(introAudio.length + outroAudio.length);
    keyAudio.set(introAudio);
    keyAudio.set(outroAudio, introAudio.length);
    const keySignal = module.arrayToVector(keyAudio);
    const found = algorithms.KeyExtractor(
      keySignal,
      true,
      4096,
      4096,
      12,
      3500,
      60,
      25,
      0.2,
      "bgate",
      rate,
      0.0001,
      440,
      "cosine",
      "hann",
    );
    keySignal.delete();

    return new BeatAnalysis({
      intro: intro.window,
      outro: outro.window,
      start,
      end,
      introEnd: Math.min(end, intro.firstBar + (introBlock ?? intro.barLevels.length) * intro.bar),
      outroStart: Math.max(start, outroEnd - outroBars * outro.bar),
      key: camelot(found.key, found.scale),
    });
  });

  return { push, analyze };
};

const decibels = (meanSquareLevel: number) => 10 * Math.log10(meanSquareLevel + 1e-12);

const meanSquare = (pcm: Float32Array, from: number, to: number) => {
  const first = Math.max(0, Math.round(from * rate));
  const last = Math.min(pcm.length, Math.round(to * rate));
  let sum = 0;
  for (let index = first; index < last; index++) sum += (pcm[index] ?? 0) ** 2;
  return sum / Math.max(1, last - first);
};

// Signed distance of `time` to the nearest beat of a grid, in seconds
const offset = (time: number, beat: number, period: number) => {
  const phase = (time - beat) / period;
  return (phase - Math.round(phase)) * period;
};

// RBJ biquad, run forward and then backward for zero phase
const filtfilt = (signal: Float32Array, type: "lowpass" | "highpass", frequency: number) => {
  const w = (2 * Math.PI * frequency) / rate;
  const cos = Math.cos(w);
  const alpha = Math.sin(w) / Math.SQRT2;
  const a0 = 1 + alpha;
  const sign = type === "lowpass" ? -1 : 1;
  const b0 = (1 + sign * cos) / 2 / a0;
  const b1 = (-sign - cos) / a0;
  const b2 = b0;
  const a1 = (-2 * cos) / a0;
  const a2 = (1 - alpha) / a0;
  const out = Float32Array.from(signal);
  for (const backward of [false, true]) {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let step = 0; step < out.length; step++) {
      const index = backward ? out.length - 1 - step : step;
      const x = out[index] ?? 0;
      const y = b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[index] = y;
    }
  }
  return out;
};

// In-place radix-2 FFT of a power-of-two length
const fft = (real: Float64Array, imaginary: Float64Array, inverse: boolean) => {
  const size = real.length;
  for (let index = 1, swap = 0; index < size; index++) {
    let bit = size >> 1;
    for (; swap & bit; bit >>= 1) swap ^= bit;
    swap ^= bit;
    if (index < swap) {
      [real[index], real[swap]] = [real[swap]!, real[index]!];
      [imaginary[index], imaginary[swap]] = [imaginary[swap]!, imaginary[index]!];
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = ((inverse ? 2 : -2) * Math.PI) / length;
    const stepReal = Math.cos(angle);
    const stepImaginary = Math.sin(angle);
    for (let block = 0; block < size; block += length) {
      let turnReal = 1;
      let turnImaginary = 0;
      for (let index = block; index < block + length / 2; index++) {
        const other = index + length / 2;
        const otherReal = real[other]! * turnReal - imaginary[other]! * turnImaginary;
        const otherImaginary = real[other]! * turnImaginary + imaginary[other]! * turnReal;
        real[other] = real[index]! - otherReal;
        imaginary[other] = imaginary[index]! - otherImaginary;
        real[index] = real[index]! + otherReal;
        imaginary[index] = imaginary[index]! + otherImaginary;
        const nextReal = turnReal * stepReal - turnImaginary * stepImaginary;
        turnImaginary = turnReal * stepImaginary + turnImaginary * stepReal;
        turnReal = nextReal;
      }
    }
  }
};

const envelopeDecimation = 10;

// Hilbert envelope of the zero-phase 30 to 150 Hz band, at 4.41 kHz. `from` is the source time of
// the first sample.
const lowEnvelope = (pcm: Float32Array, from: number) => {
  const band = filtfilt(filtfilt(pcm, "highpass", 30), "lowpass", 150);
  const length = Math.floor(band.length / envelopeDecimation);
  let size = 1;
  while (size < length) size <<= 1;
  const real = new Float64Array(size);
  const imaginary = new Float64Array(size);
  for (let index = 0; index < length; index++) real[index] = band[index * envelopeDecimation] ?? 0;
  fft(real, imaginary, false);
  for (let index = 1; index < size / 2; index++) {
    real[index] = real[index]! * 2;
    imaginary[index] = imaginary[index]! * 2;
  }
  real.fill(0, size / 2 + 1);
  imaginary.fill(0, size / 2 + 1);
  fft(real, imaginary, true);
  const values = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    values[index] = Math.hypot(real[index]!, imaginary[index]!) / size;
  }
  return { values, rate: rate / envelopeDecimation, from };
};

type Envelope = ReturnType<typeof lowEnvelope>;

// The half-rise point of the largest 8 ms envelope rise in [time - before, time + after], between
// the floor in the 30 ms before and the peak in the 40 ms after
const attackAt = (envelope: Envelope, time: number, before: number, after: number) => {
  const { values } = envelope;
  const at = (seconds: number) => Math.round((seconds - envelope.from) * envelope.rate);
  const span = (seconds: number) => Math.round(seconds * envelope.rate);
  let rise = 0;
  let rising = -1;
  for (let index = Math.max(span(0.006), at(time - before)); index <= at(time + after); index++) {
    const change = (values[index + span(0.002)] ?? 0) - (values[index - span(0.006)] ?? 0);
    if (change > rise) {
      rise = change;
      rising = index;
    }
  }
  if (rising < 0) return undefined;
  let floor = Number.POSITIVE_INFINITY;
  let floorAt = rising;
  for (let index = Math.max(0, rising - span(0.03)); index <= rising; index++) {
    if (values[index]! < floor) {
      floor = values[index]!;
      floorAt = index;
    }
  }
  let peak = 0;
  let peakAt = rising;
  for (let index = rising; index <= Math.min(values.length - 1, rising + span(0.04)); index++) {
    if (values[index]! > peak) {
      peak = values[index]!;
      peakAt = index;
    }
  }
  const half = floor + (peak - floor) / 2;
  let crossing = rising;
  for (let index = floorAt + 1; index <= peakAt; index++) {
    if (values[index]! >= half) {
      crossing = index - 1 + (half - values[index - 1]!) / (values[index]! - values[index - 1]!);
      break;
    }
  }
  return { time: envelope.from + crossing / envelope.rate, strength: peak - floor };
};

type Attack = NonNullable<ReturnType<typeof attackAt>>;

// Attacks at the peaks of the envelope rise above 10 % of its 99th percentile, 40 ms apart
const lowAttacks = (envelope: Envelope, from: number, to: number) => {
  const { values } = envelope;
  const span = (seconds: number) => Math.round(seconds * envelope.rate);
  const first = Math.max(span(0.01), Math.round((from - envelope.from) * envelope.rate));
  const last = Math.min(
    values.length - span(0.01),
    Math.round((to - envelope.from) * envelope.rate),
  );
  const rises = new Float32Array(Math.max(0, last - first));
  for (let index = first; index < last; index++) {
    rises[index - first] = Math.max(
      0,
      (values[index + span(0.002)] ?? 0) - (values[index - span(0.006)] ?? 0),
    );
  }
  // Rises below −60 dBFS are rounding noise, for example of a steady tone
  const floor = Math.max(1e-3, 0.1 * (rises.toSorted()[Math.floor(rises.length * 0.99)] ?? 0));
  const attacks: Array<Attack> = [];
  for (let index = 0; index < rises.length; index++) {
    const rise = rises[index]!;
    if (rise <= floor) continue;
    let largest = true;
    for (
      let other = Math.max(0, index - span(0.04));
      other <= Math.min(rises.length - 1, index + span(0.04));
      other++
    ) {
      if (rises[other]! > rise || (rises[other] === rise && other < index)) {
        largest = false;
        break;
      }
    }
    if (!largest) continue;
    const attack = attackAt(envelope, envelope.from + (first + index) / envelope.rate, 0.01, 0.01);
    if (attack !== undefined) attacks.push(attack);
  }
  return attacks;
};

// The densest ±4 ms cluster of attack phases within 15 % of a period of the grid, then least squares
// on the attacks within 6 ms of it, 4 times
const clusterFit = (attacks: ReadonlyArray<Attack>, period: number, beat: number) => {
  let grid = { period, beat };
  let used: ReadonlyArray<Attack> = [];
  for (let round = 0; round < 4; round++) {
    const offsets = attacks.map((attack) => offset(attack.time, grid.beat, grid.period));
    let mode = 0;
    let best = -1;
    for (let center = -0.15 * grid.period; center <= 0.15 * grid.period; center += 0.0005) {
      const count = offsets.filter((value) => Math.abs(value - center) < 0.004).length;
      if (count > best) {
        best = count;
        mode = center;
      }
    }
    const shifted = grid.beat + mode;
    used = attacks.filter((attack) => Math.abs(offset(attack.time, shifted, grid.period)) < 0.006);
    if (used.length < 8) return undefined;
    const indices = used.map((attack) => Math.round((attack.time - shifted) / grid.period));
    const line = leastSquares(
      indices,
      used.map((attack) => attack.time),
    );
    grid = {
      period: Math.abs(line.slope / grid.period - 1) < 0.01 ? line.slope : grid.period,
      beat: line.intercept,
    };
  }
  return { ...grid, attacks: used };
};

const leastSquares = (x: ReadonlyArray<number>, y: ReadonlyArray<number>) => {
  const count = x.length;
  let sumX = 0;
  let sumY = 0;
  let sumXX = 0;
  let sumXY = 0;
  x.forEach((value, index) => {
    sumX += value;
    sumY += y[index]!;
    sumXX += value * value;
    sumXY += value * y[index]!;
  });
  const slope = (count * sumXY - sumX * sumY) / (count * sumXX - sumX * sumX);
  return { slope, intercept: (sumY - slope * sumX) / count };
};

// Essentia's beat: a constant grid through its ticks, with the tempo within 1 % and the phase by
// circular mean
const tickGrid = (ticks: ReadonlyArray<number>, bpm: number) => {
  let best = { period: 60 / bpm, beat: 0, coherence: 0 };
  for (let tempo = bpm * 0.99; tempo <= bpm * 1.01; tempo += 0.002) {
    const period = 60 / tempo;
    let cos = 0;
    let sin = 0;
    for (const tick of ticks) {
      cos += Math.cos((2 * Math.PI * tick) / period);
      sin += Math.sin((2 * Math.PI * tick) / period);
    }
    const coherence = Math.hypot(cos, sin) / Math.max(1, ticks.length);
    if (coherence > best.coherence) {
      const phase = (Math.atan2(sin, cos) / (2 * Math.PI)) * period;
      best = { period, beat: ((phase % period) + period) % period, coherence };
    }
  }
  return best;
};

// Kick evidence that overrides essentia's beat must be this many times the evidence on its beat
const overrideRatio = 3;

// The kick grid: a tempo and phase search near essentia's tempo in the 10 s part with the most kick
// evidence, grown to the whole window by least squares. Essentia's beat decides between the beat and
// the off-beat, unless the kicks clearly disagree.
const kickGrid = (
  envelope: Envelope,
  prior: ReturnType<typeof tickGrid>,
  from: number,
  to: number,
) => {
  const attacks = lowAttacks(envelope, from, to);
  const evidence = (selected: ReadonlyArray<Attack>) =>
    selected.reduce((sum, attack) => sum + attack.strength, 0);
  const onGrid = (grid: { readonly period: number; readonly beat: number }) =>
    attacks.filter((attack) => Math.abs(offset(attack.time, grid.beat, grid.period)) < 0.005);
  // Calibrated on the measurement: 34 of 35 windows at 0.85 or more were within 5 ms of the kicks
  const confident = (
    grid: { readonly period: number; readonly beat: number },
    source: "kick" | "override" | "prior-kick" | "prior",
    margin: number,
  ) => {
    const coverage = onGrid(grid).length / Math.max(1, Math.floor((to - from) / grid.period));
    const result = (confidence: number) => ({ period: grid.period, beat: grid.beat, confidence });
    if (coverage < 0.3) return result((0.5 * coverage) / 0.3);
    if (source === "kick") return result(0.95);
    if (source === "override") return result(coverage >= 0.5 ? 0.9 : 0.6);
    if (source === "prior-kick") return result(margin < 2 ? 0.9 : 0.6);
    return result(0.5);
  };

  // Seeds from each 10 s part, grown to the window. The grid with the most kick evidence wins.
  let fit: { period: number; beat: number; evidence: number } | undefined;
  for (let center = from + 5; center <= to - 5; center += 5) {
    const part = attacks.filter((attack) => attack.time >= center - 5 && attack.time < center + 5);
    let grid: { period: number; beat: number } | undefined = searchGrid(part, prior.period);
    for (const half of [5, 12, 25, 60]) {
      const next = clusterFit(
        attacks.filter((attack) => Math.abs(attack.time - center) < half),
        grid.period,
        grid.beat,
      );
      if (next === undefined) {
        grid = half === 5 ? undefined : grid;
        break;
      }
      grid = next;
    }
    if (grid === undefined) continue;
    const grown = { period: grid.period, beat: grid.beat, evidence: evidence(onGrid(grid)) };
    if (fit === undefined || grown.evidence > fit.evidence) fit = grown;
  }
  if (fit === undefined) return { period: prior.period, beat: prior.beat, confidence: 0 };

  const kick = { period: fit.period, beat: fit.beat };
  const kickEvidence = evidence(onGrid(kick));
  if (Math.abs(offset(kick.beat, prior.beat, kick.period)) <= kick.period / 8) {
    return confident(kick, "kick", Number.POSITIVE_INFINITY);
  }
  // The strongest ±4 ms kick cluster within 1/8 beat of essentia's beat
  const near = attacks.filter(
    (attack) => Math.abs(offset(attack.time, prior.beat, kick.period)) < kick.period / 8,
  );
  let mode = 0;
  let strongest = -1;
  for (let center = -kick.period / 8; center <= kick.period / 8; center += 0.0005) {
    const strength = evidence(
      near.filter(
        (attack) => Math.abs(offset(attack.time, prior.beat + center, kick.period)) < 0.004,
      ),
    );
    if (strength > strongest) {
      strongest = strength;
      mode = center;
    }
  }
  const cluster = near.filter(
    (attack) => Math.abs(offset(attack.time, prior.beat + mode, kick.period)) < 0.005,
  );
  const margin = kickEvidence / Math.max(1e-12, evidence(cluster));
  if (margin >= overrideRatio) return confident(kick, "override", margin);
  const refined =
    cluster.length >= 8 ? clusterFit(cluster, kick.period, prior.beat + mode) : undefined;
  if (refined === undefined) return confident({ ...kick, beat: prior.beat }, "prior", margin);
  return confident(refined, "prior-kick", margin);
};

// Tempo within ±1.5 % of `period` in steps of 0.02 %, and phase in 1 ms steps: the largest attack
// strength within ±4 ms of the beats
const searchGrid = (attacks: ReadonlyArray<Attack>, period: number) => {
  let best = { period, beat: 0, score: -1 };
  for (let candidate = period * 0.985; candidate <= period * 1.015; candidate += period * 0.0002) {
    const bins = new Float64Array(Math.ceil(candidate / 0.001));
    for (const attack of attacks) {
      const phase = ((attack.time % candidate) + candidate) % candidate;
      bins[Math.floor(phase / 0.001)]! += attack.strength;
    }
    for (let bin = 0; bin < bins.length; bin++) {
      let score = 0;
      for (let near = -4; near <= 4; near++)
        score += bins[(bin + near + bins.length) % bins.length]!;
      if (score > best.score) best = { period: candidate, beat: (bin + 0.5) * 0.001, score };
    }
  }
  return best;
};

const chromaSize = 4096;
const hann = Float64Array.from(
  { length: chromaSize },
  (_, index) => 0.5 - 0.5 * Math.cos((2 * Math.PI * index) / chromaSize),
);
// Pitch class of each FFT bin from 80 Hz to 5 kHz, else -1
const pitchClasses = Int8Array.from({ length: chromaSize / 2 }, (_, bin) => {
  const frequency = (bin * rate) / chromaSize;
  if (frequency < 80 || frequency > 5000) return -1;
  return ((Math.round(12 * Math.log2(frequency / 440)) % 12) + 12 + 9) % 12;
});

// Unit chroma vector of [from, to) seconds of `pcm`, from frames with 50 % overlap
const chroma = (pcm: Float32Array, from: number, to: number) => {
  const sums = new Float64Array(12);
  const real = new Float64Array(chromaSize);
  const imaginary = new Float64Array(chromaSize);
  for (
    let first = Math.round(from * rate);
    first + chromaSize <= Math.round(to * rate) + chromaSize / 2 &&
    first + chromaSize <= pcm.length;
    first += chromaSize / 2
  ) {
    if (first < 0) continue;
    imaginary.fill(0);
    for (let index = 0; index < chromaSize; index++)
      real[index] = (pcm[first + index] ?? 0) * hann[index]!;
    fft(real, imaginary, false);
    for (let bin = 1; bin < chromaSize / 2; bin++) {
      const pitch = pitchClasses[bin]!;
      if (pitch >= 0) sums[pitch]! += Math.hypot(real[bin]!, imaginary[bin]!);
    }
  }
  const norm = Math.hypot(...sums) || 1;
  return sums.map((value) => value / norm);
};

// The bar phase with the largest mean of kick strength and chord change (both as z-scores) per beat.
// Confidence 0.8 was right on 90 % of windows in the measurement.
const downbeat = (
  pcm: Float32Array,
  pcmFrom: number,
  envelope: Envelope,
  grid: { readonly period: number; readonly beat: number },
  from: number,
  to: number,
) => {
  const beats: Array<number> = [];
  for (
    let at = grid.beat + Math.ceil((from - grid.beat) / grid.period) * grid.period;
    at + grid.period <= to;
    at += grid.period
  ) {
    beats.push(at);
  }
  if (beats.length < 16) return { beat: grid.beat, confidence: 0 };
  const kicks = beats.map((at) => attackAt(envelope, at, 0.01, 0.01)?.strength ?? 0);
  const chromas = [beats[0]! - grid.period, ...beats].map((at) =>
    chroma(pcm, at - pcmFrom, at + grid.period - pcmFrom),
  );
  const changes = beats.map(
    (_, index) =>
      1 -
      chromas[index + 1]!.reduce((sum, value, pitch) => sum + value * chromas[index]![pitch]!, 0),
  );
  const standard = (values: ReadonlyArray<number>) => {
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const deviation =
      Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length) || 1;
    return values.map((value) => (value - mean) / deviation);
  };
  const kickScores = standard(kicks);
  const changeScores = standard(changes);
  const sums = [0, 0, 0, 0];
  const counts = [0, 0, 0, 0];
  beats.forEach((at, index) => {
    const phase = ((Math.round((at - grid.beat) / grid.period) % 4) + 4) % 4;
    sums[phase]! += kickScores[index]! + changeScores[index]!;
    counts[phase]!++;
  });
  const means = sums.map((sum, phase) => sum / Math.max(1, counts[phase]!));
  const order = [0, 1, 2, 3].toSorted((a, b) => means[b]! - means[a]!);
  const margin = means[order[0]!]! - means[order[1]!]!;
  return {
    beat: grid.beat + order[0]! * grid.period,
    confidence: 0.6 + 0.35 * Math.min(1, margin / 0.6),
  };
};

const camelotNumbers = {
  minor: {
    "G#": 1,
    Ab: 1,
    "D#": 2,
    Eb: 2,
    "A#": 3,
    Bb: 3,
    F: 4,
    C: 5,
    G: 6,
    D: 7,
    A: 8,
    E: 9,
    B: 10,
    "F#": 11,
    Gb: 11,
    "C#": 12,
    Db: 12,
  },
  major: {
    B: 1,
    "F#": 2,
    Gb: 2,
    "C#": 3,
    Db: 3,
    "G#": 4,
    Ab: 4,
    "D#": 5,
    Eb: 5,
    "A#": 6,
    Bb: 6,
    F: 7,
    C: 8,
    G: 9,
    D: 10,
    A: 11,
    E: 12,
  },
};

const camelot = (key: string, scale: string) => {
  const minor = scale === "minor";
  const number = new Map(Object.entries(camelotNumbers[minor ? "minor" : "major"])).get(key);
  return number === undefined ? null : { number, minor };
};
