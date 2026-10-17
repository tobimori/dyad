import { Data } from "effect";

import type { Color } from "./canvas.ts";

/** An sRGB color with channels from 0 to 255 */
export class Rgb extends Data.Class<{
  readonly r: number;
  readonly g: number;
  readonly b: number;
}> {}

const rgb = (hex: number) => new Rgb({ r: (hex >> 16) & 255, g: (hex >> 8) & 255, b: hex & 255 });

/** Palettes for tracks without cover art */
export const defaultPalettes = [
  [0x3a0ca3, 0x7209b7, 0xf72585, 0xff9e00, 0x4cc9f0].map(rgb),
  [0x00f5d4, 0x00bbf9, 0x9b5de5, 0xf15bb5, 0xfee440].map(rgb),
  [0xff4800, 0xff9100, 0xffd000, 0xc1121f, 0x7b2cbf].map(rgb),
  [0x2ec4b6, 0x80ffdb, 0x48bfe3, 0x5390d9, 0x6930c3].map(rgb),
];

const lutSize = 256;

/**
 * A cyclic color gradient that presets sample. A new palette fades in over a few seconds, so a
 * track change does not jump.
 */
export class Palette {
  private readonly lut = new Float32Array(lutSize * 3);
  private readonly target = new Float32Array(lutSize * 3);
  private empty = true;

  constructor(colors: ReadonlyArray<Rgb> = defaultPalettes[0] ?? []) {
    this.set(colors);
  }

  set(colors: ReadonlyArray<Rgb>) {
    const count = colors.length;
    if (count === 0) return;
    for (let i = 0; i < lutSize; i++) {
      const position = (i / lutSize) * count;
      const index = Math.floor(position);
      const t = position - index;
      // Smoothstep keeps each color visible longer than a linear blend
      const s = t * t * (3 - 2 * t);
      const a = colors[index % count] ?? colors[0];
      const b = colors[(index + 1) % count] ?? colors[0];
      if (a === undefined || b === undefined) return;
      this.target[i * 3] = (a.r + (b.r - a.r) * s) / 255;
      this.target[i * 3 + 1] = (a.g + (b.g - a.g) * s) / 255;
      this.target[i * 3 + 2] = (a.b + (b.b - a.b) * s) / 255;
    }
    if (this.empty) this.lut.set(this.target);
    this.empty = false;
  }

  /** Moves the visible colors toward the last set palette */
  update(dt: number) {
    const k = 1 - Math.exp(-dt / 1.2);
    for (let i = 0; i < this.lut.length; i++) {
      const value = this.lut[i] ?? 0;
      this.lut[i] = value + ((this.target[i] ?? 0) - value) * k;
    }
  }

  /** Writes the color at `t` into `out`; `t` wraps around at 1 */
  sample(t: number, out: Color, brightness = 1) {
    const position = (t - Math.floor(t)) * lutSize;
    const index = Math.floor(position);
    const f = position - index;
    const a = (index % lutSize) * 3;
    const b = ((index + 1) % lutSize) * 3;
    const lut = this.lut;
    out.r = ((lut[a] ?? 0) + ((lut[b] ?? 0) - (lut[a] ?? 0)) * f) * brightness;
    out.g = ((lut[a + 1] ?? 0) + ((lut[b + 1] ?? 0) - (lut[a + 1] ?? 0)) * f) * brightness;
    out.b = ((lut[a + 2] ?? 0) + ((lut[b + 2] ?? 0) - (lut[a + 2] ?? 0)) * f) * brightness;
    return out;
  }
}

// Hue from 0 to 6
const hueOf = (r: number, g: number, b: number, max: number, delta: number) => {
  if (delta === 0) return 0;
  if (max === r) return ((g - b) / delta + 6) % 6;
  if (max === g) return (b - r) / delta + 2;
  return (r - g) / delta + 4;
};

const toHsv = (r: number, g: number, b: number) => {
  const max = Math.max(r, g, b);
  const delta = max - Math.min(r, g, b);
  return { h: hueOf(r, g, b, max, delta) / 6, s: max === 0 ? 0 : delta / max, v: max };
};

const fromHsv = (h: number, s: number, v: number) => {
  const channel = (n: number) => {
    const k = (n + h * 6) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return new Rgb({
    r: Math.round(channel(5) * 255),
    g: Math.round(channel(3) * 255),
    b: Math.round(channel(1) * 255),
  });
};

/**
 * Picks up to `count` colors from an RGBA image, such as cover art. It prefers frequent, saturated
 * colors that differ from each other, brightens them for a dark background and sorts them by hue.
 */
export const paletteFromImage = (rgba: Uint8Array, width: number, height: number, count = 5) => {
  const bins = 4096;
  const weight = new Float64Array(bins);
  const sums = new Float64Array(bins * 3);
  const pixels = width * height;
  const stride = Math.max(1, Math.floor(pixels / 20000));
  for (let p = 0; p < pixels; p += stride) {
    const o = p * 4;
    if ((rgba[o + 3] ?? 255) < 128) continue;
    const r = rgba[o] ?? 0;
    const g = rgba[o + 1] ?? 0;
    const b = rgba[o + 2] ?? 0;
    const bin = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    weight[bin] = (weight[bin] ?? 0) + 1;
    sums[bin * 3] = (sums[bin * 3] ?? 0) + r;
    sums[bin * 3 + 1] = (sums[bin * 3 + 1] ?? 0) + g;
    sums[bin * 3 + 2] = (sums[bin * 3 + 2] ?? 0) + b;
  }

  const candidates = Array.from({ length: bins }, (_, bin) => {
    const n = weight[bin] ?? 0;
    const r = n > 0 ? (sums[bin * 3] ?? 0) / n / 255 : 0;
    const g = n > 0 ? (sums[bin * 3 + 1] ?? 0) / n / 255 : 0;
    const b = n > 0 ? (sums[bin * 3 + 2] ?? 0) / n / 255 : 0;
    const hsv = toHsv(r, g, b);
    return { r, g, b, hsv, score: Math.sqrt(n) * (0.03 + hsv.s * hsv.s) * (0.1 + hsv.v) };
  })
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score);

  const picked: Array<(typeof candidates)[number]> = [];
  for (let distance = 0.35; distance > 0.05 && picked.length < count; distance *= 0.7) {
    for (const candidate of candidates) {
      if (picked.length >= count) break;
      const far = picked.every(
        (other) =>
          (other.r - candidate.r) ** 2 +
            (other.g - candidate.g) ** 2 +
            (other.b - candidate.b) ** 2 >
          distance * distance,
      );
      if (far) picked.push(candidate);
    }
  }

  return picked
    .map((color) => color.hsv)
    .sort((a, b) => a.h - b.h)
    .map((hsv) => fromHsv(hsv.h, Math.min(1, hsv.s * 1.15), 0.55 + 0.4 * hsv.v));
};
