import { AudioFrame } from "./analysis.ts";
import { Canvas } from "./canvas.ts";
import { Palette, type Rgb } from "./palette.ts";
import { Frame, type Picture, type Preset, Random } from "./preset.ts";
import { presets as defaultPresets } from "./presets/index.ts";

class Layer {
  readonly canvas: Canvas;
  readonly frame: Frame;
  preset: Preset | undefined;
  run: ((frame: Frame) => void) | undefined;

  constructor(canvas: Canvas, frame: Frame) {
    this.canvas = canvas;
    this.frame = frame;
  }
}

const toneSize = 4096;
const toneRange = 3;
// Linear up to the knee, then a soft roll-off, so that additive light saturates without hard clipping
const tone = Float32Array.from({ length: toneSize + 1 }, (_, i) => {
  const v = (i / toneSize) * toneRange;
  const knee = 0.7;
  const mapped = v < knee ? v : knee + (1 - knee) * (1 - Math.exp(-(v - knee) / (1 - knee)));
  return Math.round(Math.min(1, mapped) * 255) / 255;
});
const toneScale = toneSize / toneRange;

const transitionSeconds = 2.8;
const masks = 6;

/**
 * Renders presets into an RGBA image. A preset change blends both presets with an animated mask.
 */
export class Visualizer {
  readonly width: number;
  readonly height: number;
  readonly presets: ReadonlyArray<Preset>;
  /** RGBA pixels of the last frame */
  readonly rgba: Uint8Array;
  readonly palette = new Palette();
  /** Seconds between automatic preset changes; 0 turns them off */
  autoAdvance = 40;
  private readonly layers: readonly [Layer, Layer];
  private current = 0;
  private presetIndex = 0;
  /** 1 when no transition runs */
  private progress = 1;
  private softness = 1;
  private sinceChange = 0;
  private readonly random: Random;
  private readonly mask: Float32Array;
  private readonly display: Float32Array;
  private readonly bloomX0: Int32Array;
  private readonly bloomX1: Int32Array;
  private readonly bloomFx: Float32Array;
  private readonly bloomY0: Int32Array;
  private readonly bloomY1: Int32Array;
  private readonly bloomFy: Float32Array;

  constructor(
    width: number,
    height: number,
    presets: ReadonlyArray<Preset> = defaultPresets,
    seed = 1,
  ) {
    this.width = width;
    this.height = height;
    this.presets = presets;
    this.random = new Random(seed);
    this.rgba = new Uint8Array(width * height * 4);
    this.mask = new Float32Array(width * height);
    this.display = new Float32Array(width * height * 3);
    const silence = new AudioFrame(0, 0);
    const layer = () => {
      const canvas = new Canvas(width, height);
      return new Layer(canvas, new Frame(canvas, silence, this.palette));
    };
    this.layers = [layer(), layer()];

    const first = this.layers[0].canvas;
    const table = (size: number, lowSize: number) => {
      const low = new Int32Array(size);
      const high = new Int32Array(size);
      const frac = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        const position = Math.min(lowSize - 1, Math.max(0, (i + 0.5) / 4 - 0.5));
        low[i] = Math.floor(position);
        high[i] = Math.min(lowSize - 1, Math.floor(position) + 1);
        frac[i] = position - Math.floor(position);
      }
      return [low, high, frac] as const;
    };
    [this.bloomX0, this.bloomX1, this.bloomFx] = table(width, first.bloomWidth);
    [this.bloomY0, this.bloomY1, this.bloomFy] = table(height, first.bloomHeight);
    this.start(this.layers[0], 0);
  }

  get presetName() {
    return this.layers[this.current]?.preset?.label ?? "";
  }

  /** Fades to new colors, for example from the cover art of the next track */
  setPalette(colors: ReadonlyArray<Rgb>) {
    this.palette.set(colors);
  }

  setPicture(picture: Picture | null) {
    for (const layer of this.layers) layer.frame.picture = picture;
  }

  next() {
    this.select(this.presetIndex + 1);
  }

  previous() {
    this.select(this.presetIndex - 1);
  }

  /** Blends to the preset at `index`; a running blend ends first */
  select(index: number) {
    const count = this.presets.length;
    this.presetIndex = ((index % count) + count) % count;
    if (this.progress < 1) this.current = 1 - this.current;
    const incoming = this.layers[1 - this.current] ?? this.layers[0];
    this.start(incoming, this.presetIndex);
    this.progress = 0;
    this.sinceChange = 0;
    this.makeMask(Math.floor(this.random.next() * masks));
  }

  private start(layer: Layer, index: number) {
    const preset = this.presets[index];
    if (preset === undefined) return;
    layer.canvas.clear();
    layer.canvas.ramp = undefined;
    layer.preset = preset;
    layer.run = preset.create(layer.canvas, new Random(Math.floor(this.random.next() * 2 ** 32)));
    layer.frame.time = 0;
  }

  /** Renders one frame for `audio`; `dt` is the time since the last frame in seconds */
  render(audio: AudioFrame, dt: number) {
    const step = Math.min(0.1, Math.max(0, dt));
    this.palette.update(step);
    this.sinceChange += step;
    if (this.autoAdvance > 0 && this.sinceChange > this.autoAdvance && this.progress >= 1) {
      this.select(this.presetIndex + 1);
    }

    const current = this.layers[this.current] ?? this.layers[0];
    const incoming = this.layers[1 - this.current] ?? this.layers[1];
    const blending = this.progress < 1;
    this.renderLayer(current, audio, step);
    if (blending) this.renderLayer(incoming, audio, step);

    this.addLayer(current, blending ? -1 : 0);
    if (blending) {
      this.addLayer(incoming, 1);
      this.progress = Math.min(1, this.progress + step / transitionSeconds);
      if (this.progress >= 1) this.current = 1 - this.current;
    }
    this.writeRgba();
    return this.rgba;
  }

  private renderLayer(layer: Layer, audio: AudioFrame, dt: number) {
    const frame = layer.frame;
    frame.audio = audio;
    frame.dt = dt;
    frame.time += dt;
    layer.run?.(frame);
    if ((layer.preset?.bloom ?? 0) > 0) layer.canvas.updateBloom(0.25);
  }

  // `mode` 0 replaces the display, 1 adds with the mask weight, -1 with the inverse weight
  private addLayer(layer: Layer, mode: number) {
    const canvas = layer.canvas;
    const pixels = canvas.pixels;
    const bloom = canvas.bloom;
    const ramp = canvas.ramp;
    const strength = layer.preset?.bloom ?? 0;
    const display = this.display;
    const mask = this.mask;
    const bw = canvas.bloomWidth;
    const w = this.width;
    const s = this.softness;
    const edge = this.progress * (1 + s);
    for (let py = 0; py < this.height; py++) {
      const row0 = (this.bloomY0[py] ?? 0) * bw;
      const row1 = (this.bloomY1[py] ?? 0) * bw;
      const fy = this.bloomFy[py] ?? 0;
      for (let px = 0; px < w; px++) {
        const p = py * w + px;
        const o = p * 3;
        const x0 = this.bloomX0[px] ?? 0;
        const x1 = this.bloomX1[px] ?? 0;
        const fx = this.bloomFx[px] ?? 0;
        const a = (row0 + x0) * 3;
        const b = (row0 + x1) * 3;
        const c = (row1 + x0) * 3;
        const d = (row1 + x1) * 3;
        const w00 = (1 - fx) * (1 - fy) * strength;
        const w10 = fx * (1 - fy) * strength;
        const w01 = (1 - fx) * fy * strength;
        const w11 = fx * fy * strength;
        let r = 0;
        let g = 0;
        let bl = 0;
        if (ramp === undefined) {
          r =
            (pixels[o] ?? 0) +
            (bloom[a] ?? 0) * w00 +
            (bloom[b] ?? 0) * w10 +
            (bloom[c] ?? 0) * w01 +
            (bloom[d] ?? 0) * w11;
          g =
            (pixels[o + 1] ?? 0) +
            (bloom[a + 1] ?? 0) * w00 +
            (bloom[b + 1] ?? 0) * w10 +
            (bloom[c + 1] ?? 0) * w01 +
            (bloom[d + 1] ?? 0) * w11;
          bl =
            (pixels[o + 2] ?? 0) +
            (bloom[a + 2] ?? 0) * w00 +
            (bloom[b + 2] ?? 0) * w10 +
            (bloom[c + 2] ?? 0) * w01 +
            (bloom[d + 2] ?? 0) * w11;
          // Light above full brightness spills into the other channels and turns white
          const spill = Math.max(0, Math.max(r, g, bl) - 1) * 0.6;
          r = tone[Math.min(toneSize, ((r + spill) * toneScale) | 0)] ?? 1;
          g = tone[Math.min(toneSize, ((g + spill) * toneScale) | 0)] ?? 1;
          bl = tone[Math.min(toneSize, ((bl + spill) * toneScale) | 0)] ?? 1;
        } else {
          const level = Math.min(255, Math.max(0, (pixels[o] ?? 0) * 255) | 0) * 3;
          r = ramp[level] ?? 0;
          g = ramp[level + 1] ?? 0;
          bl = ramp[level + 2] ?? 0;
        }
        if (mode === 0) {
          display[o] = r;
          display[o + 1] = g;
          display[o + 2] = bl;
        } else {
          const t = Math.min(1, Math.max(0, (edge - (mask[p] ?? 0)) / s));
          const smooth = t * t * (3 - 2 * t);
          const weight = mode > 0 ? smooth : 1 - smooth;
          display[o] = (mode > 0 ? (display[o] ?? 0) : 0) + r * weight;
          display[o + 1] = (mode > 0 ? (display[o + 1] ?? 0) : 0) + g * weight;
          display[o + 2] = (mode > 0 ? (display[o + 2] ?? 0) : 0) + bl * weight;
        }
      }
    }
  }

  private writeRgba() {
    const display = this.display;
    const rgba = this.rgba;
    const count = this.width * this.height;
    for (let p = 0; p < count; p++) {
      const o = p * 3;
      const q = p * 4;
      rgba[q] = (display[o] ?? 0) * 255 + 0.5;
      rgba[q + 1] = (display[o + 1] ?? 0) * 255 + 0.5;
      rgba[q + 2] = (display[o + 2] ?? 0) * 255 + 0.5;
      rgba[q + 3] = 255;
    }
  }

  // Each mask gives the transition order of the pixels: 0 blends first, 1 last
  private makeMask(kind: number) {
    const w = this.width;
    const h = this.height;
    const phase = this.random.next() * Math.PI * 2;
    this.softness = kind === 0 ? 8 : 0.35;
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const value = maskValue(kind, px / w, py / h, w / h, phase);
        this.mask[py * w + px] = Math.min(1, Math.max(0, value));
      }
    }
  }
}

const maskValue = (kind: number, u: number, v: number, aspect: number, phase: number) => {
  const x = (u - 0.5) * aspect;
  const y = v - 0.5;
  const radius = Math.hypot(x, y) / Math.hypot(aspect / 2, 0.5);
  if (kind === 1) return radius;
  if (kind === 2) return 1 - radius;
  if (kind === 3) {
    const turn = (Math.atan2(y, x) + Math.PI + phase) / (Math.PI * 2);
    return turn - Math.floor(turn);
  }
  if (kind === 4) {
    return (
      0.5 +
      0.25 * Math.sin(u * 9 + phase) * Math.cos(v * 7 - phase) +
      0.25 * Math.sin((u + v) * 13 + phase * 2)
    );
  }
  if (kind === 5) return u * 0.8 + 0.1 * Math.sin(v * 12 + phase) + 0.1;
  return 0;
};
