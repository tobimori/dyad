import { Data } from "effect";

import type { AudioFrame } from "./analysis.ts";
import { type Canvas, Motion } from "./canvas.ts";
import type { Palette } from "./palette.ts";

/** A small seeded generator, so that frames repeat in checks and hot loops avoid `Math.random` */
export class Random {
  private state: number;

  constructor(seed = 0x9e3779b9) {
    this.state = seed >>> 0 || 1;
  }

  /** 0 inclusive to 1 exclusive */
  next() {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }

  range(from: number, to: number) {
    return from + (to - from) * this.next();
  }
}

/** The input of one preset frame. The visualizer reuses the instance. */
export class Frame {
  readonly canvas: Canvas;
  audio: AudioFrame;
  readonly palette: Palette;
  readonly motion = new Motion();
  /** Seconds since the preset started */
  time = 0;
  dt = 1 / 30;

  constructor(canvas: Canvas, audio: AudioFrame, palette: Palette) {
    this.canvas = canvas;
    this.audio = audio;
    this.palette = palette;
  }
}

/**
 * A visualizer preset. `create` allocates the state of one run and returns the per-frame code,
 * which usually calls `canvas.warp` with the frame motion and then draws.
 */
export class Preset extends Data.Class<{
  readonly name: string;
  /** Strength of the glow around bright parts, 0 for none */
  readonly bloom: number;
  readonly create: (canvas: Canvas, random: Random) => (frame: Frame) => void;
}> {}
