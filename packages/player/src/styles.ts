import type { Transition } from "./planner.ts";
import { timelineRate } from "./resampler.ts";

const clamp = (x: number) => Math.min(1, Math.max(0, x));

// Equal power from 0 at `from` to 1 at `to`, and back
const rising = (x: number, from: number, to: number) =>
  Math.sin((Math.PI / 2) * clamp((x - from) / (to - from)));
const falling = (x: number, from: number, to: number) =>
  Math.cos((Math.PI / 2) * clamp((x - from) / (to - from)));

const swaps = (transition: Transition) => transition.style === "blend" && transition.downbeats;

// Progress where A stops: the bass swap, the echo cut or the middle
const middle = 0.5;

/** Gain of one side at progress `x` of the overlap */
export const transitionGain = (transition: Transition, incoming: boolean, x: number) => {
  const { style } = transition;
  if (incoming) {
    if (style === "rise") return rising(x, 0, 0.25);
    if (style === "echo-out") return rising(x, 0.25, middle);
    return swaps(transition) || style === "filter" ? rising(x, 0, middle) : rising(x, 0, 1);
  }
  if (style === "echo-out") return falling(x, middle, middle + 1 / 16 / transition.beats);
  if (style === "filter") return falling(x, 0.75, 1);
  return swaps(transition) || style === "rise" ? falling(x, middle, 1) : falling(x, 0, 1);
};

const echoFeedback = 0.5;
const echoSend = 0.4;

// The echo send rises over the last bar before the cut
const sendAt = (transition: Transition, x: number) =>
  x < middle ? echoSend * clamp((x - middle) / (4 / transition.beats) + 1) : 0;

/** Upper bound of the echo level against the dry peak, for the true peak ceiling */
export const echoPeak = (transition: Transition, x: number) => {
  if (transition.style !== "echo-out") return 0;
  const beats = (x - middle) * transition.beats;
  const send = beats < 0 ? sendAt(transition, x) : echoSend * echoFeedback ** beats;
  return send / (1 - echoFeedback);
};

const killDb = -26;
const swapBeats = 1 / 8;

// Low shelf gain of the bass swap. A's bass goes out and B's bass comes in on the middle downbeat.
const shelfDb = (transition: Transition, incoming: boolean, x: number) => {
  const swapped = clamp((x - middle) / (swapBeats / transition.beats));
  return killDb * (incoming ? 1 - swapped : swapped);
};

// RBJ audio EQ cookbook biquads, stereo, direct form I
class Biquad {
  private b0 = 1;
  private b1 = 0;
  private b2 = 0;
  private a1 = 0;
  private a2 = 0;
  private readonly state = new Float64Array(8);

  private set(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number) {
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  pass(kind: "high" | "low", hz: number) {
    const w = (2 * Math.PI * hz) / timelineRate;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
    const side = kind === "low" ? 1 - cos : 1 + cos;
    const b1 = kind === "low" ? side : -side;
    this.set(side / 2, b1, side / 2, 1 + alpha, -2 * cos, 1 - alpha);
  }

  lowShelf(hz: number, db: number) {
    const a = 10 ** (db / 40);
    const w = (2 * Math.PI * hz) / timelineRate;
    const cos = Math.cos(w);
    const root = 2 * Math.sqrt(a) * (Math.sin(w) / 2) * Math.SQRT2;
    this.set(
      a * (a + 1 - (a - 1) * cos + root),
      2 * a * (a - 1 - (a + 1) * cos),
      a * (a + 1 - (a - 1) * cos - root),
      a + 1 + (a - 1) * cos + root,
      -2 * (a - 1 + (a + 1) * cos),
      a + 1 + (a - 1) * cos - root,
    );
  }

  process(pcm: Float32Array, from: number, frames: number) {
    const s = this.state;
    for (let channel = 0; channel < 2; channel++) {
      const at = 4 * channel;
      for (let frame = from; frame < from + frames; frame++) {
        const index = 2 * frame + channel;
        const x = pcm[index] ?? 0;
        const y =
          this.b0 * x +
          this.b1 * (s[at] ?? 0) +
          this.b2 * (s[at + 1] ?? 0) -
          this.a1 * (s[at + 2] ?? 0) -
          this.a2 * (s[at + 3] ?? 0);
        s[at + 1] = s[at] ?? 0;
        s[at] = x;
        s[at + 3] = s[at + 2] ?? 0;
        s[at + 2] = y;
        pcm[index] = y;
      }
    }
  }
}

// Filter settings change once per this many frames
const controlFrames = 64;

/** Filters and the echo of one side of a transition */
export class TransitionEffects {
  private readonly filter = new Biquad();
  private readonly echoFilter = new Biquad();
  private echo: Float32Array | undefined;
  private echoAt = 0;
  private readonly echoInput = new Float32Array(2 * controlFrames);

  /**
   * Applies `gains` and the style to `frames` interleaved frames. Frame `k` is at progress
   * `x + k * step`.
   */
  process(
    transition: Transition,
    incoming: boolean,
    pcm: Float32Array,
    gains: Float32Array,
    frames: number,
    x: number,
    step: number,
  ) {
    const { style } = transition;
    for (let from = 0; from < frames; from += controlFrames) {
      const length = Math.min(controlFrames, frames - from);
      const center = x + (from + length / 2) * step;
      if (swaps(transition)) {
        this.filter.lowShelf(180, shelfDb(transition, incoming, center));
        this.filter.process(pcm, from, length);
      } else if (style === "filter" && !incoming) {
        this.filter.pass("high", 20 * 100 ** clamp(center));
        this.filter.process(pcm, from, length);
      } else if (style === "rise" && incoming) {
        this.filter.pass("low", 250 * 80 ** clamp(center));
        this.filter.process(pcm, from, length);
      }
      for (let frame = from; frame < from + length; frame++) {
        const gain = gains[frame] ?? 0;
        pcm[2 * frame] = (pcm[2 * frame] ?? 0) * gain;
        pcm[2 * frame + 1] = (pcm[2 * frame + 1] ?? 0) * gain;
      }
      if (style === "echo-out" && !incoming) this.addEcho(transition, pcm, from, length, center);
    }
  }

  // A delay of one beat with feedback. Only the echo of the send has its bass removed.
  private addEcho(
    transition: Transition,
    pcm: Float32Array,
    from: number,
    frames: number,
    x: number,
  ) {
    const delay = Math.round(transition.beat * timelineRate);
    const echo = (this.echo ??= new Float32Array(2 * delay));
    const send = sendAt(transition, x);
    const input = this.echoInput;
    for (let frame = 0; frame < frames; frame++) {
      const at = 2 * ((this.echoAt + frame) % delay);
      for (let channel = 0; channel < 2; channel++) {
        const wet = echo[at + channel] ?? 0;
        const index = 2 * (from + frame) + channel;
        input[2 * frame + channel] = (pcm[index] ?? 0) * send + wet * echoFeedback;
        pcm[index] = (pcm[index] ?? 0) + wet;
      }
    }
    this.echoFilter.pass("high", 250);
    this.echoFilter.process(input, 0, frames);
    for (let frame = 0; frame < frames; frame++) {
      const at = 2 * ((this.echoAt + frame) % delay);
      echo[at] = input[2 * frame] ?? 0;
      echo[at + 1] = input[2 * frame + 1] ?? 0;
    }
    this.echoAt = (this.echoAt + frames) % delay;
  }
}
