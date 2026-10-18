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

/** A small image, such as cover art, with 3 floats per pixel from 0 to 1 */
export class Picture extends Data.Class<{
  readonly width: number;
  readonly height: number;
  readonly pixels: Float32Array;
}> {
  /** Makes a picture from RGBA bytes; transparent pixels count as black */
  static fromRgba(rgba: Uint8Array, width: number, height: number) {
    const pixels = new Float32Array(width * height * 3);
    for (let p = 0; p < width * height; p++) {
      const alpha = (rgba[p * 4 + 3] ?? 255) / 255;
      for (let channel = 0; channel < 3; channel++) {
        pixels[p * 3 + channel] = ((rgba[p * 4 + channel] ?? 0) / 255) * alpha;
      }
    }
    return new Picture({ width, height, pixels });
  }
}

/** The input of one preset frame. The visualizer reuses the instance. */
export class Frame {
  readonly canvas: Canvas;
  audio: AudioFrame;
  readonly palette: Palette;
  readonly motion = new Motion();
  /** Cover art for presets that draw it, `null` without one */
  picture: Picture | null = null;
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
  /** Group of related presets, for example "Ambience" */
  readonly collection?: string | undefined;
  /** Strength of the glow around bright parts, 0 for none */
  readonly bloom: number;
  readonly create: (canvas: Canvas, random: Random) => (frame: Frame) => void;
}> {
  /** The name with the collection in front, for example "Ambience: Water" */
  get label() {
    return this.collection === undefined ? this.name : `${this.collection}: ${this.name}`;
  }
}
