import { Data } from "effect";

import { type Canvas, Color } from "../../canvas.ts";
import { type Frame, Preset } from "../../preset.ts";
import { gradient, hex } from "./color.ts";
import { History } from "./history.ts";

const collection = "Musical Colors";
const mirror = (u: number) => Math.abs(u * 2 - 1);

/** A spectrum history drawn as rows from the front at the bottom to the back */
class Terrain extends Data.Class<{
  readonly rows: number;
  /** History frames between two drawn rows */
  readonly step: number;
  /** Image fractions of the front row */
  readonly left: number;
  readonly right: number;
  readonly base: number;
  /** Negative to move the row down with the level */
  readonly height: number;
  /** Offset of the back row from the front row in image fractions; positive `shiftY` is up */
  readonly shiftX: number;
  readonly shiftY: number;
  /** Fraction by which the back row is smaller than the front row */
  readonly shrink: number;
  /** Spectrum position at `u` from the left to the right of a row */
  readonly map?: (u: number) => number;
  /** Height fraction of the colored band below the top of each column, to the base when unset */
  readonly thickness?: number;
  /** Adds light instead of hiding the rows behind */
  readonly add?: boolean;
  /**
   * Sets `out` for a pixel `edge` below the top of its column and at `height` above the base, both
   * as fractions of the row height, in the row at `depth` from 0 (front) to 1
   */
  readonly color: (
    out: Color,
    edge: number,
    height: number,
    depth: number,
    u: number,
    time: number,
  ) => void;
}> {}

const color = new Color();
let skyline = new Int32Array(0);

const drawTerrain = (canvas: Canvas, history: History, terrain: Terrain, time: number) => {
  const w = canvas.width;
  const h = canvas.height;
  const pixels = canvas.pixels;
  if (skyline.length < w) skyline = new Int32Array(w);
  skyline.fill(h, 0, w);
  const map = terrain.map ?? ((u: number) => u);
  const occlude = terrain.add !== true;
  for (let d = 0; d < terrain.rows; d++) {
    const depth = terrain.rows > 1 ? d / (terrain.rows - 1) : 0;
    const size = 1 - terrain.shrink * depth;
    const middle = ((terrain.left + terrain.right) / 2 + terrain.shiftX * depth) * w;
    const half = ((terrain.right - terrain.left) / 2) * size * w;
    const base = (terrain.base - terrain.shiftY * depth) * h;
    const rowHeight = terrain.height * size * h;
    const span = Math.abs(rowHeight);
    const band = terrain.thickness === undefined ? Infinity : terrain.thickness * span;
    const x0 = Math.max(0, Math.ceil(middle - half));
    const x1 = Math.min(w - 1, Math.floor(middle + half));
    for (let x = x0; x <= x1; x++) {
      const u = (x - middle + half) / (2 * half);
      const top = base - history.at(d * terrain.step, map(u)) * rowHeight;
      const bottom = Math.min(
        occlude ? (skyline[x] ?? h) : h,
        rowHeight > 0 ? base : h,
        top + band,
      );
      const y0 = Math.max(0, Math.ceil(top));
      for (let y = y0; y < bottom; y++) {
        terrain.color(color, (y - top) / span, (base - y) / span, depth, u, time);
        const o = (y * w + x) * 3;
        pixels[o] = occlude ? color.r : (pixels[o] ?? 0) + color.r;
        pixels[o + 1] = occlude ? color.g : (pixels[o + 1] ?? 0) + color.g;
        pixels[o + 2] = occlude ? color.b : (pixels[o + 2] ?? 0) + color.b;
      }
      if (occlude && y0 < (skyline[x] ?? h)) skyline[x] = y0;
    }
  }
};

const musical = (
  name: string,
  draw: (canvas: Canvas, frame: Frame, history: History) => void,
  smoothing = 0,
  keep = 0,
) =>
  new Preset({
    name,
    collection,
    bloom: 0,
    create: (canvas) => {
      const history = new History();
      return (frame: Frame) => {
        history.push(frame.audio.spectrum, smoothing ** (frame.dt * 30));
        const pixels = canvas.pixels;
        const fade = keep ** (frame.dt * 30);
        for (let o = 0; o < pixels.length; o++) pixels[o] = (pixels[o] ?? 0) * fade;
        draw(canvas, frame, history);
      };
    },
  });

const terrainPreset = (name: string, terrain: Terrain, smoothing = 0) =>
  musical(
    name,
    (canvas, frame, history) => drawTerrain(canvas, history, terrain, frame.time),
    smoothing,
  );

const scale = (stops: ReadonlyArray<number>) => stops.map(hex);
const shade = (out: Color, k: number) => out.set(out.r * k, out.g * k, out.b * k);
// Pseudo-random speckle that stays on one pixel for a frame
const speckle = (a: number, b: number) => {
  const s = Math.sin(a * 127.1 + b * 311.7) * 43758.5453;
  return s - Math.floor(s);
};

const iceStops = scale([0xff8020, 0xffc000, 0xf0f000, 0x40e000, 0x00e0e0, 0x2080ff]);
export const musicalIceCrystals = terrainPreset(
  "ice crystals",
  new Terrain({
    rows: 22,
    step: 1,
    left: 0,
    right: 1,
    base: 1,
    height: 0.75,
    shiftX: 0.14,
    shiftY: 0.12,
    shrink: 0.1,
    color: (out, _edge, height, depth) => shade(gradient(iceStops, height, out), 1 - depth * 0.5),
  }),
);

const winStops = scale([0x2060e0, 0xf08040, 0xffd000, 0xc0e000, 0x00c040, 0x00e0e0]);
export const musicalWinMe3d = terrainPreset(
  "WinMe 3D",
  new Terrain({
    rows: 30,
    step: 1,
    left: 0,
    right: 0.8,
    base: 1,
    height: 0.7,
    shiftX: 0.4,
    shiftY: 0.45,
    shrink: 0.4,
    color: (out, _edge, height, depth) => {
      gradient(winStops, height, out);
      return out.set(out.r * (1 - depth * 0.4), out.g * (1 - depth) ** 2, out.b * (1 - depth) ** 2);
    },
  }),
);

const silkyCool = scale([0x40e0ff, 0xe8ffff, 0xffffff, 0x80d8ff, 0x2040c0, 0x081040]);
const silkyWarm = scale([0x80e0ff, 0xffffff, 0xff4070, 0xe0204a, 0x2040e0, 0x30d0ff]);
const silkyA = new Color();
const silkyB = new Color();
export const musicalSilkyWave = terrainPreset(
  "silky wave",
  new Terrain({
    rows: 16,
    step: 2,
    left: 0,
    right: 1,
    base: 1,
    height: 0.6,
    shiftX: 0.08,
    shiftY: 0.12,
    shrink: 0,
    color: (out, edge, _height, depth, _u, time) => {
      const mix = 0.5 + 0.5 * Math.sin(time * 0.4);
      gradient(silkyCool, edge * 1.4, silkyA);
      gradient(silkyWarm, edge * 1.4, silkyB);
      const k = 1 - depth * 0.6;
      return out.set(
        (silkyA.r + (silkyB.r - silkyA.r) * mix) * k,
        (silkyA.g + (silkyB.g - silkyA.g) * mix) * k,
        (silkyA.b + (silkyB.b - silkyA.b) * mix) * k,
      );
    },
  }),
  0.85,
);

const auroraStops = scale([0xd02000, 0xff8040, 0xffffff, 0xff9060, 0xc02000, 0x300800, 0x000000]);
export const musicalAurora = terrainPreset(
  "aurora",
  new Terrain({
    rows: 48,
    step: 1,
    left: 0,
    right: 1,
    base: 1.02,
    height: 0.4,
    shiftX: 0.04,
    shiftY: 0.45,
    shrink: 0,
    color: (out, _edge, _height, depth) => gradient(auroraStops, depth * 1.3, out),
  }),
  0.85,
);

export const musicalElectricGreen = terrainPreset(
  "electric green",
  new Terrain({
    rows: 3,
    step: 10,
    left: 0,
    right: 1,
    base: 1,
    height: 0.5,
    shiftX: 0.05,
    shiftY: 0.35,
    shrink: 0,
    thickness: 0.4,
    add: true,
    color: (out, edge) => {
      const k = Math.exp(-((edge - 0.1) ** 2) * 120) * 0.9;
      return out.set(k * 0.1, k, k * 0.1);
    },
  }),
  0.85,
);

const swirlStops = scale([0xfff080, 0xffc000, 0xf08000, 0xa03000, 0x200800]);
export const musicalYellowSwirl = terrainPreset(
  "yellow swirl",
  new Terrain({
    rows: 40,
    step: 1,
    left: 0,
    right: 1,
    base: 1,
    height: 0.55,
    shiftX: -0.25,
    shiftY: 0.7,
    shrink: 0.6,
    color: (out, edge, _height, depth) =>
      shade(gradient(swirlStops, edge * 2, out), 1 - depth * 0.3),
  }),
);

const fireStops = scale([0xffff80, 0xffd000, 0xff8000, 0xc02000, 0x300000]);
export const musicalHotSpray = terrainPreset(
  "hot spray",
  new Terrain({
    rows: 20,
    step: 1,
    left: 0,
    right: 1,
    base: 1,
    height: 0.65,
    shiftX: 0.05,
    shiftY: 0.25,
    shrink: 0,
    color: (out, edge, height, depth) =>
      shade(gradient(fireStops, edge * 2.5 + speckle(edge, height) * 0.4, out), 1 - depth * 0.5),
  }),
);

const sprayStops = scale([0xffffff, 0xd0f8ff, 0xa0e8f8, 0x80c8e0, 0x305060]);
export const musicalWaterSpray = terrainPreset(
  "water spray",
  new Terrain({
    rows: 20,
    step: 1,
    left: 0,
    right: 1,
    base: 1,
    height: 0.65,
    shiftX: 0.05,
    shiftY: 0.25,
    shrink: 0,
    color: (out, edge, height, depth) =>
      shade(gradient(sprayStops, edge * 2 + speckle(edge, height) * 0.5, out), 1 - depth * 0.4),
  }),
);

export const musicalRollingFire = terrainPreset(
  "rolling fire",
  new Terrain({
    rows: 24,
    step: 1,
    left: 0.12,
    right: 0.88,
    base: 1,
    height: 0.5,
    shiftX: 0,
    shiftY: 0.4,
    shrink: 0,
    map: mirror,
    color: (out, edge, height, depth, u, time) => {
      const roll = Math.sin(height * 50 + Math.sin(u * 40) * 2 - time * 6);
      return gradient(fireStops, 0.25 + edge * 0.6 + roll * 0.25 + depth * 0.2, out);
    },
  }),
  0.6,
);

const hardStops = scale([0xffffff, 0xffe080, 0xe0a020, 0x4080ff, 0x102040]);
export const musicalHardRock = terrainPreset(
  "hard rock",
  new Terrain({
    rows: 3,
    step: 6,
    left: 0,
    right: 1,
    base: 0.05,
    height: -0.75,
    shiftX: 0,
    shiftY: -0.3,
    shrink: 0,
    map: (u) => mirror(u) * 0.35,
    thickness: 0.15,
    add: true,
    color: (out, edge, height, depth) =>
      shade(
        gradient(hardStops, edge * 6.6, out),
        (1 - depth * 0.4) * (0.6 + speckle(edge, height) * 0.6),
      ),
  }),
  0.5,
);

export const musicalNightLights = terrainPreset(
  "night lights",
  new Terrain({
    rows: 3,
    step: 3,
    left: 0.05,
    right: 0.95,
    base: 1,
    height: 0.85,
    shiftX: 0,
    shiftY: 0,
    shrink: 0.3,
    map: mirror,
    add: true,
    color: (out, edge, height) => {
      const k = Math.min(1, edge * 3) * (1 - height) ** 1.5 * 0.5;
      const white = Math.max(0, 0.15 - height) * 2;
      return out.set(k * 0.2 + white, k * 0.85 + white, k + white);
    },
  }),
  0.5,
);

export const musicalSoftFire = terrainPreset(
  "soft fire",
  new Terrain({
    rows: 1,
    step: 1,
    left: 0,
    right: 1,
    base: 1,
    height: 0.8,
    shiftX: 0,
    shiftY: 0,
    shrink: 0,
    map: (u) => mirror((u * 3) % 1) * 0.6,
    color: (out, edge, height) =>
      gradient(fireStops, 1 - Math.min(1, edge * 2.5) * 0.7 - (1 - height) * 0.3, out),
  }),
  0.6,
);

const cutoutSky = scale([0x30e8f0, 0x40e0b0, 0xa0e040, 0xf0e000, 0x30e8f0]);
export const musicalCutout = musical(
  "cutout",
  (canvas, frame, history) => {
    const w = canvas.width;
    const h = canvas.height;
    const pixels = canvas.pixels;
    const t = frame.time / 40;
    gradient(cutoutSky, t - Math.floor(t), color);
    const soft = h * 0.08;
    for (let x = 0; x < w; x++) {
      const top = h * (0.85 - 0.55 * history.at(0, mirror(x / (w - 1)) * 0.7));
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 3;
        const k = Math.min(1, Math.max(0, (top - y) / soft));
        pixels[o] = color.r * k;
        pixels[o + 1] = color.g * k;
        pixels[o + 2] = color.b * k;
      }
    }
  },
  0.8,
);

const rainbow = scale([
  0xff0000, 0xff8000, 0xffff00, 0x00ff00, 0x00ffff, 0x0040ff, 0xff00ff, 0xff0000,
]);
export const musicalElectricRainbow = musical(
  "electric rainbow",
  (canvas, frame, history) => {
    const w = canvas.width;
    const h = canvas.height;
    const pixels = canvas.pixels;
    for (let x = 0; x < w; x++) {
      const u = mirror(x / (w - 1)) * 0.8;
      const top = h * (1 - 0.85 * history.at(0, u));
      const back = h * (1 - 0.85 * history.at(6, u));
      for (let y = 0; y < h; y++) {
        const o = (y * w + x) * 3;
        if (y >= top) {
          const k = y < back ? 0 : 0.25;
          pixels[o] = 0;
          pixels[o + 1] = k * 0.8;
          pixels[o + 2] = k;
          continue;
        }
        const t = ((top - y) / h) * 1.4 + frame.time * 0.15;
        gradient(rainbow, t - Math.floor(t), color);
        pixels[o] = color.r;
        pixels[o + 1] = color.g;
        pixels[o + 2] = color.b;
      }
    }
  },
  0.5,
);

const acidStops = scale([0x40ff40, 0x80ff60, 0xe0ff80, 0xff60e0, 0xff20c0]);
export const musicalAcidRock = musical("acid rock", (canvas, frame, history) => {
  const a = frame.time * 0.35;
  drawTerrain(
    canvas,
    history,
    new Terrain({
      rows: 24,
      step: 1,
      left: 0,
      right: 0.9 - 0.4 * Math.abs(Math.sin(a * 0.7)),
      base: 1,
      height: 0.5,
      shiftX: 0.5 * Math.cos(a),
      shiftY: 0.6 * Math.abs(Math.sin(a)),
      shrink: 0.4,
      color: (out, edge, height, depth) => {
        gradient(acidStops, height * 0.6 + depth * 0.5, out);
        return shade(out, 1 - Math.min(0.6, edge * 0.8));
      },
    }),
    frame.time,
  );
});

const starColors = scale([0x2050c0, 0xb0b000, 0xe05010, 0x701818, 0x2030b0]);
const starCenter = hex(0x00e0ff);
const starEdge = hex(0x00c040);
const background = new Color();
export const musicalStarPower = musical("star power", (canvas, frame) => {
  const w = canvas.width;
  const h = canvas.height;
  const pixels = canvas.pixels;
  const t = frame.time / 12;
  gradient(
    starColors,
    t / (starColors.length - 1) - Math.floor(t / (starColors.length - 1)),
    background,
  );
  const inner = 0.25 + 0.15 * frame.audio.bassAtt;
  const outer = 0.55 + 0.4 * frame.audio.bassAtt;
  const spin = frame.time * 0.1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = (x - (w - 1) / 2) / canvas.scale;
      const dy = (y - (h - 1) / 2) / canvas.scale;
      const r = Math.sqrt(dx * dx + dy * dy);
      const s = ((Math.atan2(dy, dx) + spin) / (Math.PI * 2)) * 12;
      const spike = 1 - Math.abs((s - Math.floor(s)) * 2 - 1);
      const radius = inner + (outer - inner) * spike * spike;
      const f = r / radius;
      const o = (y * w + x) * 3;
      const k = Math.min(1, Math.max(0, (1 - f) * 4));
      const g = Math.min(1, f);
      pixels[o] = background.r * (1 - k) + (starCenter.r + (starEdge.r - starCenter.r) * g) * k;
      pixels[o + 1] = background.g * (1 - k) + (starCenter.g + (starEdge.g - starCenter.g) * g) * k;
      pixels[o + 2] = background.b * (1 - k) + (starCenter.b + (starEdge.b - starCenter.b) * g) * k;
    }
  }
});

const flameColors = scale([0x2040ff, 0xff2020, 0x20e040, 0x2040ff]);
const flameInner = new Color();
export const musicalBlueFlame = musical(
  "blue flame",
  (canvas, frame, history) => {
    const t = frame.time / 10;
    gradient(flameColors, t / 3 - Math.floor(t / 3), color);
    gradient(flameColors, (t + 1.5) / 3 - Math.floor((t + 1.5) / 3), flameInner);
    const baseY = 0.75;
    const count = 24;
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const level = history.at(0, 0.02 + f * 0.5);
      const reach = (0.1 + f * 1.3) * (0.4 + level);
      const rise = (1.5 - f * 1.1) * (0.35 + level * 0.8);
      const c = f < 0.4 ? flameInner : color;
      const gain = 1.2 * (1 - f * 0.4);
      let lastX = 0;
      let lastY = baseY;
      for (let s = 1; s <= 12; s++) {
        const p = s / 12;
        const x = reach * Math.sin(p * Math.PI * 0.6);
        const y = baseY - rise * p * p;
        canvas.line(lastX, lastY, x, y, c.r * gain, c.g * gain, c.b * gain);
        canvas.line(-lastX, lastY, -x, y, c.r * gain, c.g * gain, c.b * gain);
        lastX = x;
        lastY = y;
      }
    }
    const spike = 0.6 + history.at(0, 0.01) * 0.9;
    canvas.line(0, baseY, 0, baseY - spike, flameInner.r * 2, flameInner.g * 2, flameInner.b * 2);
  },
  0.4,
  0.6,
);

const critterTop = hex(0xf0e040);
const critterSide = hex(0x30d0d0);
export const musicalCritterRock = musical(
  "critter rock",
  (canvas, _frame, history) => {
    const base = 0.75;
    const width = canvas.aspect * 0.85;
    canvas.line(-canvas.aspect, base, -width, base, 2, 0.3, 2);
    canvas.line(width, base, canvas.aspect, base, 2, 0.3, 2);
    const count = 160;
    for (let i = 0; i <= count; i++) {
      const u = i / count;
      const m = mirror(u);
      const x = (u * 2 - 1) * width;
      gradient([critterTop, critterSide], Math.min(1, m * 3), color);
      for (let d = 0; d < 12; d++) {
        const level = history.at(d * 2, m * 0.6);
        const y = base - level * (0.25 + (1 - m) ** 3 * 1.4) + d * 0.02;
        const k = 4 * (1 - d / 12);
        canvas.point(x, y, color.r * k, color.g * k, color.b * k);
      }
    }
  },
  0.3,
);

const rhythmColors = scale([0xff3030, 0xf0f040, 0x30f0f0, 0x40ff60, 0xff40ff, 0xff3030]);
export const musicalRhythmicColors = musical(
  "rhythmic colors",
  (canvas, frame) => {
    const samples = frame.audio.waveform;
    const count = 240;
    const width = canvas.aspect * 0.9;
    let fast = 0;
    let smooth = 0;
    let lastX = -width;
    let lastY = 0;
    for (let i = 0; i < count; i++) {
      fast += ((samples[Math.floor((i / count) * samples.length)] ?? 0) - fast) * 0.06;
      smooth += (fast - smooth) * 0.06;
      const x = (i / (count - 1)) * 2 * width - width;
      const y = Math.tanh(smooth * 2) * 0.8;
      const t = frame.time / 20 + i / count / 3;
      gradient(rhythmColors, t - Math.floor(t), color);
      canvas.line(lastX, lastY, x, y, color.r * 1.5, color.g * 1.5, color.b * 1.5);
      lastX = x;
      lastY = y;
    }
  },
  0,
  0.5,
);

const motionColors = scale([0xff2010, 0xff2010, 0xffe020, 0x40ff40, 0x20a0ff]);
export const musicalColorsInMotion = musical(
  "colors in motion",
  (canvas, frame, history) => {
    const rows = 60;
    const dots = 40;
    for (let d = 0; d < rows; d++) {
      const p = d / rows;
      const a = frame.time * 0.3 + p * 2.5;
      const cx = Math.sin(a) * canvas.aspect * 0.6;
      const cy = Math.cos(a * 1.3) * 0.5;
      const nx = Math.cos(a * 0.7);
      const ny = Math.sin(a * 0.9);
      for (let i = 0; i < dots; i++) {
        const u = i / (dots - 1);
        const level = history.at(d, u * 0.6);
        const s = (u - 0.5) * (0.8 + p);
        gradient(motionColors, level * 0.8, color);
        const k = 3 * (0.5 + level);
        canvas.point(
          cx + nx * s,
          cy + ny * s - level * 0.25,
          color.r * k,
          color.g * k,
          color.b * k,
        );
      }
    }
  },
  0.3,
);

const neonColors = scale([0xff40ff, 0xffffff, 0xffff40, 0x40ffff, 0xff40ff]);
export const musicalNeonHighway = musical(
  "neon highway",
  (canvas, frame, history) => {
    const lanes = 4;
    for (let lane = 0; lane < lanes; lane++) {
      const t = lane / lanes + frame.time * 0.02;
      gradient(neonColors, t - Math.floor(t), color);
      for (let d = 0; d < 6; d++) {
        const k = 3.5 * (1 - d / 8);
        for (let i = 0; i < 160; i++) {
          const u = i / 159;
          const x = (u * 2 - 1) * canvas.aspect * 0.95;
          const phase = frame.time * 0.6 + lane * 0.5;
          const level = history.at(d * 2, u * 0.6);
          const y =
            0.1 +
            lane * 0.12 +
            d * 0.025 +
            0.35 * Math.sin(u * 5 + phase) * (1 - u * 0.4) -
            level * 0.12;
          canvas.point(x, y, color.r * k, color.g * k, color.b * k);
        }
      }
    }
  },
  0.3,
);
