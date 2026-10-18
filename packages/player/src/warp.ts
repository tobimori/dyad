import { Data } from "effect";

import type { Resampler } from "./resampler.ts";
import { stretcherCapacity } from "./stretch.ts";
import type { Stretcher } from "./stretch.ts";

/** Entry frames of lane frames: a constant rate, then a linear ramp to rate 1 */
export class TempoMap extends Data.Class<{
  /** Lane frame that plays entry frame `entry` */
  readonly frame: number;
  readonly entry: number;
  readonly rate: number;
  /** Lane frames at `rate` from `frame` */
  readonly frames: number;
  /** Lane frames of the ramp after them */
  readonly rampFrames: number;
}> {}

/** The entry frame that lane frame `frame` plays, with a fraction */
export const entryAt = (map: TempoMap, frame: number) => {
  const held = frame - map.frame;
  if (held <= map.frames) return map.entry + map.rate * held;
  const ramp = Math.min(held - map.frames, map.rampFrames);
  return (
    map.entry +
    map.rate * (map.frames + ramp) +
    ((1 - map.rate) * ramp ** 2) / (2 * map.rampFrames) +
    (held - map.frames - ramp)
  );
};

/** The lane frame where `map` ends */
export const tempoMapEnd = (map: TempoMap) => map.frame + map.frames + map.rampFrames;

// The stretched and the direct audio are the same after the ramp, so a short linear fade joins them
const handoffFrames = 1024;
const chunkFrames = 512;
const historyFrames = 1 << 15;

/**
 * Plays a lane through a stretcher on a tempo map. After the map, it fades to the direct audio,
 * whose lane frames are its entry frames, and then only passes the resampler on.
 */
export class Warp {
  private readonly stretcher: Stretcher;
  readonly map: TempoMap;
  /** Next lane frame */
  output: number;
  done = false;
  /** Entry frame of the next resampler frame. After the input ends, it counts silence. */
  private fed: number;
  // Lane frame of the next stretcher output, which runs `outputLatency` ahead when it starts
  private stretched: number;
  private primed = false;
  private readonly handoff: number;
  /** The first lane frame of only direct audio */
  readonly directFrom: number;
  // The input of the last `historyFrames` entry frames, for the fade to the direct audio
  private readonly history = new Float32Array(2 * historyFrames);
  private readonly input = new Float32Array(2 * stretcherCapacity);
  private readonly faded = new Float32Array(2 * chunkFrames);

  constructor(stretcher: Stretcher, map: TempoMap, start: number) {
    this.stretcher = stretcher;
    this.map = map;
    this.output = start;
    this.stretched = start - stretcher.outputLatency;
    this.fed = this.target(this.stretched) - this.seekFrames;
    this.handoff = Math.ceil(tempoMapEnd(map));
    this.directFrom = this.handoff + handoffFrames;
  }

  /** Entry frame where the resampler must start */
  get inputStart() {
    return this.fed;
  }

  private get seekFrames() {
    return this.stretcher.inputLatency + this.stretcher.outputLatency;
  }

  // The input that the stretcher has read when its next output is lane frame `frame`
  private target(frame: number) {
    return Math.round(
      entryAt(this.map, frame + this.stretcher.outputLatency) + this.stretcher.inputLatency,
    );
  }

  /** Lane frames that `pull` can write before the resampler needs more input */
  available(resampler: Resampler) {
    if (this.done) return resampler.available;
    if (resampler.ended) return Number.POSITIVE_INFINITY;
    // After the handoff, lane frames are entry frames
    const input = resampler.output + resampler.available;
    const end = this.directFrom;
    if (this.target(end) <= input) return input - this.output;
    let low = 0;
    let high = end - this.output;
    while (low < high) {
      const frames = Math.ceil((low + high) / 2);
      if (this.target(this.output + frames) <= input) low = frames;
      else high = frames - 1;
    }
    return low;
  }

  /** The input ended, and the lane played all of it */
  finished(resampler: Resampler) {
    return (
      resampler.ended && entryAt(this.map, this.output) >= resampler.outputAt(resampler.inputEnd)
    );
  }

  /** Writes `frames` lane frames to `out` from frame `at` */
  pull(resampler: Resampler, out: Float32Array, at: number, frames: number) {
    if (this.done) return resampler.pull(out, at, frames);
    if (!this.primed) this.prime(resampler);
    let written = 0;
    while (written < frames && !this.done) {
      const frame = this.output;
      const end = this.directFrom;
      const limit = [this.handoff, end, this.fed].find((each) => frame < each) ?? frame;
      const length = Math.min(frames - written, chunkFrames, limit - frame);
      if (frame < this.handoff) {
        this.stretch(resampler, out, at + written, length);
        this.output += length;
        written += length;
        continue;
      }
      if (frame < end) this.stretch(resampler, this.faded, 0, length);
      for (let index = 0; index < length; index++) {
        const direct = Math.min(1, (frame + index - this.handoff) / handoffFrames);
        const source = 2 * this.historyIndex(frame + index);
        const target = 2 * (at + written + index);
        for (let channel = 0; channel < 2; channel++) {
          out[target + channel] =
            (this.faded[2 * index + channel] ?? 0) * (1 - direct) +
            (this.history[source + channel] ?? 0) * direct;
        }
      }
      this.output += length;
      written += length;
      this.done = this.output === this.fed;
    }
    if (written < frames) written += resampler.pull(out, at + written, frames - written);
    return written;
  }

  private historyIndex(entry: number) {
    return ((entry % historyFrames) + historyFrames) % historyFrames;
  }

  // Reads input frames from the resampler, and silence after its end
  private read(resampler: Resampler, frames: number) {
    const got = resampler.pull(this.input, 0, frames);
    this.input.fill(0, 2 * got, 2 * frames);
    for (let index = 0; index < frames; index++) {
      const target = 2 * this.historyIndex(this.fed + index);
      this.history[target] = this.input[2 * index] ?? 0;
      this.history[target + 1] = this.input[2 * index + 1] ?? 0;
    }
    this.fed += frames;
  }

  private prime(resampler: Resampler) {
    this.primed = true;
    this.read(resampler, this.seekFrames);
    this.stretcher.seek(this.input, this.seekFrames, this.map.rate);
    const preroll = new Float32Array(2 * chunkFrames);
    while (this.stretched < this.output) {
      const length = Math.min(chunkFrames, this.output - this.stretched);
      this.stretch(resampler, preroll, 0, length);
    }
  }

  private stretch(resampler: Resampler, out: Float32Array, at: number, frames: number) {
    const inputs = this.target(this.stretched + frames) - this.fed;
    this.read(resampler, inputs);
    this.stretcher.process(this.input, inputs, out, at, frames);
    this.stretched += frames;
  }
}
