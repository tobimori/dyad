/** Frames per second of the timeline */
export const timelineRate = 44100;

const greatestCommonDivisor = (a: number, b: number) => {
  let x = a;
  let y = b;
  while (y !== 0) [x, y] = [y, x % y];
  return x;
};

// Taps on each side of the center at the input rate; downsampling widens the kernel
const halfTaps = 32;

// The cutoff stays below the lower Nyquist frequency, so that the Blackman transition band does
// not reach it
const cutoff = 0.92;

const blackman = (x: number) =>
  0.42 + 0.5 * Math.cos(Math.PI * x) + 0.08 * Math.cos(2 * Math.PI * x);

/**
 * Windowed-sinc conversion to the timeline rate. Output frame `k` is at input time
 * `k * rate / 44100`, so the same output frame always comes from the same input frames.
 */
export class Resampler {
  readonly rate: number;
  /** Output frames per `down` input frames */
  private readonly up: number;
  private readonly down: number;
  private readonly taps: number;
  /** Taps before the input frame at or before the output time */
  private readonly before: number;
  /** One row of `taps` coefficients for each of the `up` output phases */
  private readonly kernel: Float32Array;
  private left = new Float32Array(1 << 16);
  private right = new Float32Array(1 << 16);
  /** Input frame of `left[0]` */
  private first: number;
  private length = 0;
  /** Input frame after the last pushed frame */
  inputEnd: number;
  /** Next output frame */
  output: number;
  ended = false;

  constructor(rate: number, output: number) {
    const divisor = greatestCommonDivisor(timelineRate, rate);
    this.rate = rate;
    this.up = timelineRate / divisor;
    this.down = rate / divisor;
    this.output = output;

    const unity = this.up === this.down;
    const half = Math.ceil(halfTaps * Math.max(1, this.down / this.up));
    const band = 0.5 * cutoff * Math.min(1, this.up / this.down);
    this.taps = unity ? 1 : 2 * half;
    this.before = unity ? 0 : half - 1;
    this.kernel = new Float32Array(this.up * this.taps);

    for (let phase = 0; phase < this.up; phase++) {
      const row = phase * this.taps;
      let sum = 0;
      for (let tap = 0; tap < this.taps; tap++) {
        const t = tap - this.before - phase / this.up;
        const sinc = t === 0 ? 1 : Math.sin(2 * Math.PI * band * t) / (2 * Math.PI * band * t);
        const value = unity ? 1 : sinc * blackman(t / half);
        this.kernel[row + tap] = value;
        sum += value;
      }
      // Each phase passes DC at gain 1
      for (let tap = 0; tap < this.taps; tap++) {
        this.kernel[row + tap] = (this.kernel[row + tap] ?? 0) / sum;
      }
    }

    // Before input frame 0 the input is silence
    const input = this.inputFor(output);
    const silence = Math.max(0, -input);
    this.first = input;
    this.reserve(silence);
    this.length = silence;
    this.inputEnd = Math.max(0, input);
  }

  /** First output frame at or after input frame `input` */
  outputAt(input: number) {
    return Math.ceil((input * this.up) / this.down);
  }

  // First input frame that output frame `frame` reads
  private inputFor(frame: number) {
    return Math.floor((frame * this.down) / this.up) - this.before;
  }

  /** Appends input frames at a gain. A mono source plays on both sides. */
  push(channels: ReadonlyArray<Float32Array>, frames: number, gain: number) {
    const left = channels[0] ?? new Float32Array(frames);
    const right = channels[1] ?? left;
    this.reserve(frames);
    for (let i = 0; i < frames; i++) {
      this.left[this.length + i] = (left[i] ?? 0) * gain;
      this.right[this.length + i] = (right[i] ?? 0) * gain;
    }
    this.length += frames;
    this.inputEnd += frames;
  }

  /** Marks the end of the input. The last output frames read silence after it. */
  end() {
    this.reserve(this.taps);
    this.left.fill(0, this.length, this.length + this.taps);
    this.right.fill(0, this.length, this.length + this.taps);
    this.length += this.taps;
    this.ended = true;
  }

  /** All output frames of the input are out */
  get done() {
    return this.ended && this.output >= this.outputAt(this.inputEnd);
  }

  /** Writes up to `frames` interleaved stereo frames to `out` from frame `at`. Gives the count. */
  pull(out: Float32Array, at: number, frames: number) {
    const last = this.ended ? this.outputAt(this.inputEnd) : Number.POSITIVE_INFINITY;
    const kernel = this.kernel;
    const left = this.left;
    const right = this.right;

    let written = 0;
    while (written < frames && this.output < last) {
      const position = this.output * this.down;
      const index = Math.floor(position / this.up);
      const start = index - this.before - this.first;
      if (start + this.taps > this.length) break;

      const row = (position - index * this.up) * this.taps;
      let l = 0;
      let r = 0;
      for (let tap = 0; tap < this.taps; tap++) {
        const weight = kernel[row + tap] ?? 0;
        l += (left[start + tap] ?? 0) * weight;
        r += (right[start + tap] ?? 0) * weight;
      }

      out[2 * (at + written)] = l;
      out[2 * (at + written) + 1] = r;
      written += 1;
      this.output += 1;
    }
    return written;
  }

  // Drops input that no later output reads, and grows the buffers to hold `frames` more
  private reserve(frames: number) {
    const drop = Math.max(0, Math.min(this.length, this.inputFor(this.output) - this.first));
    if (drop > 0) {
      this.left.copyWithin(0, drop, this.length);
      this.right.copyWithin(0, drop, this.length);
      this.first += drop;
      this.length -= drop;
    }

    if (this.length + frames <= this.left.length) return;
    const capacity = Math.max(2 * this.left.length, this.length + frames);
    const left = new Float32Array(capacity);
    const right = new Float32Array(capacity);
    left.set(this.left.subarray(0, this.length));
    right.set(this.right.subarray(0, this.length));
    this.left = left;
    this.right = right;
  }
}
