import { type Canvas, Color, type Motion } from "../../canvas.ts";
import { type Frame, Preset } from "../../preset.ts";
import { hex } from "./color.ts";
import { History } from "./history.ts";

const tau = Math.PI * 2;
const blue = hex(0x0000ff);
const yellow = hex(0xffff00);
const white = hex(0xffffff);

// Spectrum level around a circle, mirrored so that the bass is at the top and the bottom
const around = (history: History, t: number) =>
  history.at(0, Math.abs(((t * 2 + 0.25) % 1) * 2 - 1) * 0.7);

/** Paints a soft shape over the image; `radius(t)` is the edge at the angle `t` from 0 to 1 */
const blob = (
  canvas: Canvas,
  cx: number,
  cy: number,
  sx: number,
  reach: number,
  radius: (t: number) => number,
  color: Color,
) => {
  const w = canvas.width;
  const pixels = canvas.pixels;
  const x0 = Math.max(0, Math.floor(canvas.px(cx - reach * sx)));
  const x1 = Math.min(w - 1, Math.ceil(canvas.px(cx + reach * sx)));
  const y0 = Math.max(0, Math.floor(canvas.py(cy - reach)));
  const y1 = Math.min(canvas.height - 1, Math.ceil(canvas.py(cy + reach)));
  const soft = 3 / canvas.scale;
  for (let py = y0; py <= y1; py++) {
    const dy = (py + 0.5 - canvas.height / 2) / canvas.scale - cy;
    for (let px = x0; px <= x1; px++) {
      const dx = ((px + 0.5 - w / 2) / canvas.scale - cx) / sx;
      const r = Math.sqrt(dx * dx + dy * dy);
      const k = Math.min(1, (radius(Math.atan2(dy, dx) / tau + 0.5) - r) / soft);
      if (k <= 0) continue;
      const o = (py * w + px) * 3;
      pixels[o] = (pixels[o] ?? 0) + (color.r - (pixels[o] ?? 0)) * k;
      pixels[o + 1] = (pixels[o + 1] ?? 0) + (color.g - (pixels[o + 1] ?? 0)) * k;
      pixels[o + 2] = (pixels[o + 2] ?? 0) + (color.b - (pixels[o + 2] ?? 0)) * k;
    }
  }
};

const plenoptic = (
  name: string,
  // Brightness that each channel keeps per 1/30 s, so that colors shift as they fade
  keep: Color,
  move: (motion: Motion, frame: Frame) => void,
  draw: (canvas: Canvas, frame: Frame, history: History) => void,
) =>
  new Preset({
    name,
    collection: "Plenoptic",
    bloom: 0,
    create: (canvas) => {
      const history = new History();
      return (frame: Frame) => {
        history.push(frame.audio.spectrum, 0.5 ** (frame.dt * 30));
        const motion = frame.motion.reset();
        motion.decay = 1;
        move(motion, frame);
        canvas.warp(motion, frame.time, frame.dt);
        draw(canvas, frame, history);
        const steps = frame.dt * 30;
        const r = keep.r ** steps;
        const g = keep.g ** steps;
        const b = keep.b ** steps;
        const pixels = canvas.pixels;
        // Paint does not add up to white
        for (let o = 0; o < pixels.length; o += 3) {
          pixels[o] = Math.min(1, (pixels[o] ?? 0) * r);
          pixels[o + 1] = Math.min(1, (pixels[o + 1] ?? 0) * g);
          pixels[o + 2] = Math.min(1, (pixels[o + 2] ?? 0) * b);
        }
      };
    },
  });

const circlePairs = [
  [0x0000ff, 0x00ff00],
  [0xffff00, 0xff8000],
  [0x00ff00, 0xffff00],
  [0xff0000, 0x0000ff],
].map((pair) => pair.map(hex));
export const plenopticSmokeyCircles = plenoptic(
  "smokey circles",
  new Color().set(0.995, 0.995, 0.995),
  (motion) => {
    motion.zoom = 1.035;
    motion.warp = 1.5;
    motion.warpSpeed = 0.5;
  },
  (canvas, frame, history) => {
    const pair = circlePairs[Math.floor(frame.time / 20) % circlePairs.length] ?? [];
    const radius = (t: number) => 0.1 + around(history, t) * 0.35;
    blob(canvas, 0, 0, 1, 0.5, (t) => (t < 0.25 || t > 0.75 ? radius(t) : 0), pair[0] ?? blue);
    blob(canvas, 0, 0, 1, 0.5, (t) => (t < 0.25 || t > 0.75 ? 0 : radius(t)), pair[1] ?? blue);
  },
);

export const plenopticSmokeyLines = plenoptic(
  "smokey lines",
  new Color().set(0.995, 0.995, 0.995),
  (motion) => {
    motion.cy = 0.1;
    motion.sy = 1.04;
    motion.warp = 1.5;
    motion.warpSpeed = 0.5;
  },
  (canvas, _frame, history) => {
    const w = canvas.width;
    const pixels = canvas.pixels;
    const base = Math.floor(canvas.py(0.25));
    for (let px = 0; px < w; px++) {
      const level = history.at(0, Math.abs((px / (w - 1)) * 2 - 1) * 0.7);
      const tip = Math.max(0, Math.floor(canvas.py(0.15 - level * 0.5)));
      for (let py = Math.max(0, tip - Math.floor(canvas.scale * 0.1)); py < base; py++) {
        const o = (py * w + px) * 3;
        const red = py >= tip ? 1 : 0;
        pixels[o] = red;
        pixels[o + 1] = 0;
        pixels[o + 2] = 1 - red;
      }
    }
  },
);

const voxCore = hex(0xff8000);
const voxEdge = hex(0xffe000);
export const plenopticVox = plenoptic(
  "vox",
  new Color().set(0.7, 0.7, 0.7),
  (motion) => {
    motion.zoom = 1.01;
  },
  (canvas, frame) => {
    const samples = frame.audio.waveform;
    const w = canvas.width;
    const h = canvas.height;
    const pixels = canvas.pixels;
    const half = 0.85;
    for (let px = 0; px < w; px++) {
      const x = (px + 0.5 - w / 2) / canvas.scale;
      const f = Math.abs(x) / half;
      if (f >= 1) continue;
      const sample = Math.abs(samples[Math.floor((px / w) * samples.length)] ?? 0);
      const a = (1 - f ** 4) ** 0.5 * (0.25 + Math.min(0.45, sample * 1.5)) * canvas.scale;
      const y0 = Math.max(0, Math.floor(h / 2 - a));
      const y1 = Math.min(h - 1, Math.ceil(h / 2 + a));
      for (let py = y0; py <= y1; py++) {
        const d = Math.abs(py + 0.5 - h / 2) / a;
        const k = Math.min(1, (1 - d) * 4);
        if (k <= 0) continue;
        const g = voxCore.g + (voxEdge.g - voxCore.g) * Math.min(1, d * 3);
        const o = (py * w + px) * 3;
        pixels[o] = (pixels[o] ?? 0) + (voxEdge.r - (pixels[o] ?? 0)) * k;
        pixels[o + 1] = (pixels[o + 1] ?? 0) + (g - (pixels[o + 1] ?? 0)) * k;
        pixels[o + 2] = (pixels[o + 2] ?? 0) * (1 - k);
      }
    }
  },
);

export const plenopticFlame = plenoptic(
  "flame",
  new Color().set(0.985, 0.9, 0.6),
  (motion) => {
    motion.dy = -0.025;
    motion.sx = 0.99;
    motion.warp = 3;
    motion.warpSpeed = 2;
    motion.warpScale = 0.6;
  },
  (canvas, frame, history) => {
    blob(canvas, 0, 0.3, 1, 0.6, (t) => 0.12 + around(history, t) * 0.3, yellow);
    blob(canvas, 0, 0.8, 1.4, 0.3, () => 0.1 + frame.audio.bassAtt * 0.06, blue);
  },
);

export const plenopticFountain = plenoptic(
  "fountain",
  new Color().set(0.93, 0.85, 0.7),
  (motion) => {
    motion.cy = 0.6;
    motion.zoom = 1.04;
    motion.dy = 0.006;
    motion.warp = 1.5;
  },
  (canvas, frame, history) => {
    const count = 60;
    for (let i = 0; i < count; i++) {
      const f = i / (count - 1);
      const angle = (f * 2 - 1) * 0.6;
      const r = 0.25 + history.at(0, Math.abs(f * 2 - 1) * 0.6) * 0.8;
      canvas.line(0, 0.6, Math.sin(angle) * r, 0.6 - Math.cos(angle) * r, 4, 4, 0);
    }
    blob(canvas, 0, 0.82, 1.5, 0.3, () => 0.1 + frame.audio.bassAtt * 0.06, blue);
  },
);

export const plenopticSpyro = plenoptic(
  "spyro",
  new Color().set(0.95, 0.9, 0.8),
  (motion, frame) => {
    motion.cy = 0.1;
    motion.zoom = 1.025;
    motion.rot = 0.04 * Math.sin(frame.time * 0.3);
    motion.warp = 1;
  },
  (canvas, frame, history) => {
    const spin = frame.time * 0.8;
    for (let i = 0; i < 6; i++) {
      const t = i / 6;
      const a = spin + t * tau;
      const r = 0.25 + around(history, t) * 0.3;
      blob(
        canvas,
        Math.cos(a) * r,
        0.1 + Math.sin(a) * r * 0.6,
        1,
        0.12,
        () => 0.05 + around(history, t) * 0.06,
        yellow,
      );
    }
    blob(canvas, 0, 0.7, 2.2, 0.25, (t) => 0.1 + around(history, t) * 0.08, white);
    blob(canvas, 0, 0.7, 2.2, 0.2, () => 0.08, blue);
  },
);
