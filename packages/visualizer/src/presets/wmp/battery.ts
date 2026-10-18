import type { Canvas, Motion } from "../../canvas.ts";
import type { Frame } from "../../preset.ts";
import { ambienceFamily, ring, Style, wave } from "./ambience.ts";
import { hex } from "./color.ts";

// Zoom that changes with the angle, so that bright parts near the center streak out in rays
const burst = (v: Motion, angle: number, rays: number, zoom: number, phase: number) => {
  const s = Math.abs(Math.sin((angle * rays) / 2 + phase));
  v.zoom = 1 + zoom * (0.25 + 0.75 * s * s * s);
};

/** Draws a disc of dots that turns by `spin` and leans back by `tilt`, with waveform jitter */
const dotPlane = (
  canvas: Canvas,
  frame: Frame,
  count: number,
  radius: number,
  spin: number,
  tilt: number,
  level: number,
  cx = 0,
  cy = 0,
) => {
  const samples = frame.audio.waveform;
  const cs = Math.cos(spin);
  const ss = Math.sin(spin);
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  const gain = level / (canvas.detail * canvas.detail);
  for (let j = 0; j < count; j++) {
    for (let i = 0; i < count; i++) {
      const u = (i / (count - 1)) * 2 - 1;
      const w = (j / (count - 1)) * 2 - 1;
      if (u * u + w * w > 1) continue;
      const h = (samples[(j * count + i) % samples.length] ?? 0) * 0.3;
      const x = (u * cs - w * ss) * radius;
      const z = (u * ss + w * cs) * radius;
      const depth = 2.5 / (2.5 + z * ct);
      canvas.point(cx + x * depth, cy + (z * st + h) * depth, gain, 0, 0);
    }
  }
};

/** Draws `count` spiral arms of dots around (`cx`, `cy`) */
const arms = (
  canvas: Canvas,
  count: number,
  radius: number,
  spin: number,
  curl: number,
  level: number,
  cx = 0,
  cy = 0,
) => {
  const gain = level / (canvas.detail * canvas.detail);
  const steps = Math.round(radius * canvas.scale * 0.35);
  for (let k = 0; k < count; k++) {
    for (let i = 1; i <= steps; i++) {
      const r = (i / steps) * radius;
      const a = spin + (k / count) * Math.PI * 2 + (r / radius) * curl;
      canvas.point(cx + Math.cos(a) * r * 1.1, cy + Math.sin(a) * r, gain, 0, 0);
    }
  }
};

/** Raises the level to at least `level` inside the ellipse with the radii `rx` and `ry` */
const fill = (canvas: Canvas, rx: number, ry: number, level: number, cx = 0, cy = 0) => {
  const w = canvas.width;
  const h = canvas.height;
  const pixels = canvas.pixels;
  for (let y = 0; y < h; y++) {
    const v = ((y - (h - 1) / 2) / canvas.scale - cy) / ry;
    if (v * v >= 1) continue;
    const half = Math.sqrt(1 - v * v) * rx * canvas.scale;
    const middle = (w - 1) / 2 + cx * canvas.scale;
    const left = Math.max(0, Math.ceil(middle - half));
    const right = Math.min(w - 1, Math.floor(middle + half));
    for (let x = left; x <= right; x++) {
      const o = (y * w + x) * 3;
      pixels[o] = Math.max(pixels[o] ?? 0, level);
    }
  }
};

let scratch = new Float32Array(0);

// Zooms the image inside each square tile about the tile center; the mesh warp cannot keep the
// tile edges sharp
const tileZoom = (canvas: Canvas, tiles: number, zoom: number) => {
  const w = canvas.width;
  const h = canvas.height;
  const size = Math.max(2, Math.round(h / tiles));
  const pixels = canvas.pixels;
  if (scratch.length < w * h) scratch = new Float32Array(w * h);
  for (let p = 0; p < w * h; p++) scratch[p] = pixels[p * 3] ?? 0;
  const half = (size - 1) / 2;
  for (let y = 0; y < h; y++) {
    const top = y - (y % size);
    const sy = Math.min(h - 1, Math.round(top + half + (y - top - half) / zoom));
    for (let x = 0; x < w; x++) {
      const left = x - (x % size);
      const sx = Math.min(w - 1, Math.round(left + half + (x - left - half) / zoom));
      pixels[(y * w + x) * 3] = scratch[sy * w + sx] ?? 0;
    }
  }
};

const brightsphere = new Style({
  hue: 10,
  palette: [0x180818, 0x3f2e40, 0x625664, 0x948a97, 0xf4f0f4].map(hex),
  base: 0.02,
  decay: 0.97,
  move: (v, _x, _y, radius, angle, frame) => {
    if (radius < 0.68) {
      v.rot = 0.02;
      v.zoom = 0.995;
      return;
    }
    burst(v, angle, 40, 0.05, frame.time * 0.1);
  },
  draw: (canvas, frame) => {
    ring(canvas, frame, 0.68, 0.68, 0.04, 0.8 + 0.6 * frame.audio.bassAtt);
    dotPlane(canvas, frame, 9, 0.55, frame.time * 0.4, 0.3, 0.9);
  },
});

const freakyCircles = new Style({
  hue: 9,
  palette: [0xa759c8, 0x8e33a8, 0x6b2293, 0x441e84, 0x3a1a78].map(hex),
  base: 0,
  decay: 0.99,
  post: (canvas) => tileZoom(canvas, 26, 0.9),
  move: (v) => {
    v.rot = 0.01;
    v.warp = 0.6;
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.7;
    const level = 0.15 + 0.15 * frame.audio.bassAtt;
    const dx = Math.cos(a) * 0.3;
    const dy = Math.sin(a) * 0.18;
    ring(canvas, frame, 0.36, 0.36, 0.25, level, dx, dy);
    ring(canvas, frame, 0.36, 0.36, 0.25, level, -dx, -dy);
  },
});

const cominatcha = new Style({
  hue: 10,
  palette: [0x281c28, 0x46384a, 0x6e6272, 0xa8a2aa, 0xffffff].map(hex),
  base: 0.3,
  decay: 0.97,
  move: (v, _x, _y, _radius, angle, frame) => burst(v, angle, 24, 0.05, frame.time * 0.05),
  draw: (canvas, frame) => {
    const { audio } = frame;
    canvas.glow(0, 0, 0.25, 0.02 + 0.04 * audio.bassAtt, 0, 0);
    ring(canvas, frame, 0.12, 0.12, 0.6, 0.15);
    const gain = 1 / (canvas.detail * canvas.detail);
    for (let i = 0; i < 8; i++) {
      const a = Math.sin(frame.time * 13.7 + i * 7.1) * Math.PI;
      const r = 0.2 + 0.6 * Math.abs(Math.sin(frame.time * 3.1 + i * 1.7));
      canvas.point(Math.cos(a) * r * 1.4, Math.sin(a) * r, gain, 0, 0);
    }
  },
});

// Blades of light from a bright core that drifts below the center
const blades = (rays: number, drift: number) => (v: Motion, x: number, y: number, frame: Frame) => {
  const cx = drift * Math.sin(frame.time * 0.13);
  const cy = drift * 0.5 + drift * 0.3 * Math.sin(frame.time * 0.11);
  v.cx = cx;
  v.cy = cy;
  burst(v, Math.atan2(y - cy, x - cx), rays, 0.06, frame.time * 0.03);
};

const cottonBlades = blades(22, 0.3);
const cottonstar = new Style({
  hue: 12,
  palette: [0x3b293b, 0x5f5261, 0x837a85, 0xcbd3d0, 0xffffff].map(hex),
  base: 0.2,
  decay: 0.97,
  move: (v, x, y, _radius, _angle, frame) => cottonBlades(v, x, y, frame),
  draw: (canvas, frame) => {
    const cx = 0.3 * Math.sin(frame.time * 0.13);
    const cy = 0.15 + 0.09 * Math.sin(frame.time * 0.11);
    canvas.glow(cx, cy, 0.1, 0.3 + 0.3 * frame.audio.bassAtt, 0, 0);
    wave(canvas, frame, cx, cy, frame.time, 0.5, 0.15, 0, 0.8);
  },
});

const dandelionBlades = blades(20, 0.08);
const dandelionaid = new Style({
  hue: 5,
  palette: [0x1a0c1a, 0x3a2a40, 0x3da28b, 0x71b39e, 0xe8fff4].map(hex),
  base: 0.1,
  decay: 0.97,
  move: (v, x, y, _radius, _angle, frame) => dandelionBlades(v, x, y, frame),
  draw: (canvas, frame) => {
    canvas.glow(0, 0, 0.15, 0.3 + 0.3 * frame.audio.bassAtt, 0, 0);
    wave(canvas, frame, 0, 0, frame.time * 0.7, 0.6, 0.2, 0, 0.8);
  },
});

const drinkdeep = new Style({
  hue: 7,
  palette: [0x5c9ad0, 0x68a9d2, 0x8ecacd, 0x377cd0, 0x1850c0, 0xe8fcff].map(hex),
  base: 0,
  decay: 0.99,
  move: (v, x, y, _radius, _angle, frame) => {
    if (Math.hypot((x - 0.15) / 1.1, y) < 0.75) {
      v.cx = 0.15;
      v.rot = 0.03;
      v.zoom = 0.99;
      return;
    }
    v.zoom = 0.985;
    v.dx = 0.004 * Math.sin(y * 18 + frame.time * 2);
    v.dy = 0.004 * Math.sin(x * 18 + frame.time * 1.7);
  },
  draw: (canvas, frame) => {
    ring(canvas, frame, canvas.aspect, 0.98, 0.01, 0.6 + 0.6 * Math.sin(frame.time * 8));
    fill(canvas, 0.7 * 1.1, 0.7, 0.45, 0.15);
    arms(canvas, 7, 0.65, -frame.time * 0.6, 2.4, 0.5 + 0.3 * frame.audio.bassAtt, 0.15);
  },
});

const eletriarnation = new Style({
  hue: 4,
  palette: [0x1a2214, 0x3d4a37, 0x5f6c5a, 0x8d9987, 0xeef4e8].map(hex),
  base: 0.3,
  decay: 0.985,
  move: (v, _x, _y, radius, angle) => {
    v.rot = 0.03 * Math.sin(radius * 9);
    v.zoom = 1.01 + 0.012 * Math.sin(angle * 8);
    v.warp = 0.8;
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.3;
    for (let k = 0; k < 4; k++) {
      wave(canvas, frame, 0, 0, a + (k * Math.PI) / 4, 1.6, 0.12, k / 4, 0.15);
    }
  },
});

const eventHorizon = new Style({
  hue: 1,
  palette: [0x0c1004, 0x2a3220, 0x905040, 0xd09080, 0xffffff].map(hex),
  base: 0,
  decay: 0.9,
  move: (v) => {
    v.swirl = 0.06;
    v.zoom = 0.99;
  },
  draw: (canvas, frame) =>
    dotPlane(
      canvas,
      frame,
      18,
      0.5 + 0.1 * frame.audio.bassAtt,
      frame.time * 0.5,
      1.2 + 0.2 * Math.sin(frame.time * 0.3),
      2,
      0.15,
      0.1,
    ),
});

const hizodge = new Style({
  hue: 5,
  palette: [0x2e7c6a, 0xeef2f2, 0xd4e0de, 0x24604f, 0x0c3226].map(hex),
  base: 0,
  decay: 0.94,
  move: (v, _x, _y, radius) => {
    v.swirl = 0.12;
    v.zoom = radius > 0.8 ? 0.985 : 1;
  },
  draw: (canvas, frame) => {
    ring(canvas, frame, canvas.aspect, 0.98, 0.01, 0.3 + 0.3 * Math.sin(frame.time * 6));
    fill(canvas, 1.05, 0.82, 0.25);
    const a = frame.time * 0.4;
    wave(canvas, frame, 0, 0, a, 1.2, 0.25, 0, 0.5);
    wave(canvas, frame, 0, 0, a + 1.4, 0.9, 0.25, 0.5, 0.5);
  },
});

const gemstonematrix = new Style({
  hue: 4,
  palette: [0x140e04, 0x1f5a1c, 0x2fbc42, 0x58f070, 0xd0ffe0].map(hex),
  base: 0,
  decay: 0.94,
  post: (canvas) => tileZoom(canvas, 7, 1.1),
  move: () => undefined,
  draw: (canvas, frame) => {
    const bands = frame.audio.bands;
    const cell = 2 / 7;
    const tick = Math.floor(frame.time * 4);
    for (let i = 0; i < 10; i++) {
      const level = bands[(i * 7) % bands.length] ?? 0;
      if (level < 0.35) continue;
      const column = Math.floor((0.5 + 0.5 * Math.sin(i * 12.9898 + tick)) * canvas.aspect * 7);
      const row = Math.floor((0.5 + 0.5 * Math.sin(i * 78.233 + tick)) * 7);
      const x = -canvas.aspect + (column + 0.5) * cell;
      const y = -1 + (row + 0.5) * cell;
      canvas.glow(x, y, cell * 0.5, level * 0.4, 0, 0);
    }
  },
});

const sepiaswirl = new Style({
  hue: 2,
  palette: [0x4a2618, 0x7a4630, 0xa86232, 0xd08a48, 0xfff0e0].map(hex),
  base: 0.25,
  decay: 0.98,
  move: (v) => {
    v.swirl = 0.16;
    v.zoom = 0.995;
    v.warp = 0.6;
  },
  draw: (canvas, frame) => {
    const r = 0.35 + 0.12 * frame.audio.bassAtt;
    ring(canvas, frame, r, r, 0.5, 0.5);
    ring(canvas, frame, r * 0.5, r * 0.5, 0.4, 0.4);
  },
});

const illuminator = new Style({
  hue: 11,
  palette: [0x2a1418, 0x3b1f26, 0x5a3024, 0x8a5a3a, 0xc89a70].map(hex),
  base: 0.25,
  decay: 0.985,
  move: (v, _x, _y, radius) => {
    v.rot = (Math.floor(radius * 6) % 2 === 0 ? 1 : -1) * 0.02;
    v.zoom = 1.004;
  },
  draw: (canvas, frame) => {
    const level = 0.08 + 0.06 * frame.audio.bassAtt;
    ring(canvas, frame, 0.85, 0.85, 0.03, level);
    ring(canvas, frame, 0.18, 0.18, 0.15, level, -0.3, 0);
    ring(canvas, frame, 0.18, 0.18, 0.15, level, 0.3, 0);
  },
});

const iSeeTheTruth = new Style({
  hue: 3,
  palette: [0x4c4ca8, 0x77768a, 0xa1a560, 0xc8c870, 0xfffff0].map(hex),
  base: 0.1,
  decay: 0.995,
  edge: (x, y) => (Math.hypot(x / 1.15, y) > 0.92 ? 0.8 : 1),
  move: (v, _x, _y, radius, angle, frame) => {
    v.zoom = 1.01;
    v.rot = 0.015 * Math.sin(radius * 12 + frame.time);
    v.dx = 0.003 * Math.sin(angle * 9);
    v.warp = 0.5;
  },
  draw: (canvas, frame) => {
    canvas.glow(0, 0, 0.2, 0.08 + 0.1 * frame.audio.bassAtt, 0, 0);
    ring(canvas, frame, 0.3, 0.3, 0.5, 0.4);
    ring(canvas, frame, 0.85 * 1.15, 0.85, 0.05, 0.4);
  },
});

const kaleidovision = new Style({
  hue: 4,
  palette: [0x2ee82e, 0x3da651, 0x50628a, 0x8a8a58, 0xe8d890].map(hex),
  base: 0,
  decay: 0.985,
  move: (v, _x, _y, radius) => {
    v.rot = (Math.floor(radius * 10) % 2 === 0 ? 1 : -1) * 0.05;
    v.zoom = 1.02;
    v.warp = 0.4;
  },
  draw: (canvas, frame) => {
    const level = 0.4 + 0.3 * frame.audio.bassAtt;
    ring(canvas, frame, 0.12, 0.12, 0.6, level);
    const a = frame.time * 0.5;
    ring(canvas, frame, 0.08, 0.08, 0.2, level, Math.cos(a) * 0.5, Math.sin(a) * 0.4);
    ring(canvas, frame, 0.08, 0.08, 0.2, level, -Math.cos(a) * 0.5, -Math.sin(a) * 0.4);
  },
});

const chemicalnova = new Style({
  hue: 8,
  palette: [
    0x101008, 0x161430, 0x20175d, 0x3a40c8, 0x40b8a0, 0xc0409e, 0xf06070, 0xf0a040, 0xe0e050,
  ].map(hex),
  base: 0,
  decay: 0.97,
  move: (v, _x, _y, radius, angle) => {
    v.zoom = 1.02 + 0.01 * Math.sin(angle * 2);
    v.rot = 0.006;
    v.swirl = radius < 0.3 ? -0.05 : 0;
  },
  draw: (canvas, frame) => {
    const r = 0.3 + 0.08 * frame.audio.bassAtt;
    ring(canvas, frame, r * 1.2, r, 0.35, 0.9);
    wave(canvas, frame, 0, 0, 0.6, canvas.aspect * 2, 0.1, 0.3, 0.4);
  },
});

const lotusBlades = blades(18, 0.35);
const lotus = new Style({
  hue: 8,
  palette: [0x0a0414, 0x4a1648, 0xa04898, 0xd2a6ce, 0xffffff].map(hex),
  base: 0,
  decay: 0.95,
  move: (v, x, y, _radius, _angle, frame) => lotusBlades(v, x, y, frame),
  draw: (canvas, frame) => {
    const cx = 0.35 * Math.sin(frame.time * 0.13);
    const cy = 0.17 + 0.1 * Math.sin(frame.time * 0.11);
    canvas.glow(cx, cy, 0.2, 0.15 + 0.15 * frame.audio.bassAtt, 0, 0);
    wave(canvas, frame, cx, cy, -frame.time * 0.6, 0.6, 0.2, 0, 0.8);
  },
});

const greenEnemy = new Style({
  hue: 4,
  palette: [0x0c2604, 0x116505, 0x18a10e, 0x28d824, 0xd8ffd0].map(hex),
  base: 0.25,
  decay: 0.99,
  move: (v, x, y, _radius, _angle, frame) => {
    if (Math.hypot(x / 1.25, y) < 0.85) {
      v.swirl = 0.08;
      v.rot = 0.01;
      return;
    }
    v.zoom = 0.985;
    v.dx = 0.005 * Math.sin(y * 14 + frame.time * 2);
    v.dy = 0.005 * Math.sin(x * 14 + frame.time * 2);
  },
  draw: (canvas, frame) => {
    ring(canvas, frame, canvas.aspect, 0.98, 0.01, 0.8 + 0.8 * Math.sin(frame.time * 8));
    arms(canvas, 7, 0.8, frame.time * 0.5, 4, 0.25 + 0.2 * frame.audio.bassAtt);
  },
});

const relativelyCalm = new Style({
  hue: 6,
  palette: [0x0c1c24, 0x45759a, 0x6297b3, 0x90c4c4, 0xf0ffff].map(hex),
  base: 0,
  decay: 0.995,
  edge: (x, y) => (Math.hypot(x / 1.25, y) > 1 ? 0.85 : 1),
  move: (v, _x, y) => {
    v.zoom = 1.006;
    v.rot = 0.006;
    v.sx = 1.01;
    v.dx = 0.006 * Math.sin(y * 20);
  },
  draw: (canvas, frame) => {
    fill(canvas, 1.45, 1.05, 0.4);
    wave(canvas, frame, 0, 0, -0.1, canvas.aspect * 1.6, 0.15, 0, 0.12 + 0.1 * frame.audio.bassAtt);
  },
});

const sleepyspray = new Style({
  hue: 6,
  palette: [0x0c1822, 0x2f566f, 0x6ba5b5, 0x98c9c7, 0xf0ffff].map(hex),
  base: 0.35,
  decay: 0.995,
  edge: (x) => (x < -1.45 ? 0.6 : 1),
  move: (v, x, y) => {
    v.dx = 0.012;
    v.dy = -0.006 + 0.003 * Math.sin(x * 3);
    v.sy = 1 + 0.004 * Math.sin(y * 7);
  },
  draw: (canvas, frame) => {
    const x = -canvas.aspect * 0.75;
    wave(canvas, frame, x, 0, Math.PI / 2 - 0.25, 2.2, 0.12, 0, 0.35);
    wave(canvas, frame, x + 0.05, 0, Math.PI / 2 - 0.25, 2.2, 0.12, 0.5, 0.25);
  },
});

const smokeOrWater = new Style({
  hue: 10,
  palette: [0x161028, 0x34304e, 0x5e5c6e, 0x9f9fa3, 0xe8e8f0].map(hex),
  base: 0.3,
  decay: 0.975,
  move: (v) => {
    v.warp = 2.4;
    v.warpScale = 1.6;
    v.warpSpeed = 0.8;
  },
  draw: (canvas, frame) =>
    wave(canvas, frame, 0.2 * Math.sin(frame.time * 0.2), 0, 0.8, 1.2, 0.2, 0, 0.25),
});

const spiders = new Style({
  hue: 4,
  palette: [0x101104, 0x1d570f, 0x29a425, 0x40d040, 0xb0f0b0].map(hex),
  base: 0,
  decay: 0.93,
  move: (v) => {
    v.rot = -0.04;
    v.zoom = 1.01;
    v.swirl = 0.05;
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.9;
    wave(canvas, frame, 0, 0, a, 1.6, 0.3, 0, 0.5);
    wave(canvas, frame, 0, 0, a + 1.2, 0.7, 0.4, 0.5, 0.4);
  },
});

const strawberryaid = new Style({
  hue: 1,
  palette: [0x500010, 0x99192b, 0xbb4d5e, 0xd88896, 0xffffff].map(hex),
  base: 0.35,
  decay: 0.97,
  move: (v, _x, _y, radius, angle, frame) => {
    burst(v, angle, 30, 0.05, frame.time * 0.05);
    if (radius < 0.15) v.zoom = 0.98;
  },
  draw: (canvas, frame) => {
    const r = 0.22 + 0.08 * frame.audio.bassAtt;
    ring(canvas, frame, r, r, 0.4, 0.9);
    for (let k = 0; k < 3; k++) {
      const a = Math.sin(frame.time * 7.3 + k * 2.1) * Math.PI;
      const d = 0.4 + 0.3 * Math.sin(frame.time * 5.1 + k);
      wave(canvas, frame, Math.cos(a) * d, Math.sin(a) * d, a + 1.2, 0.3, 0.1, k / 3, 0.5);
    }
  },
});

const theWorld = new Style({
  hue: 12,
  palette: [0x302626, 0x5e5050, 0x8e7f80, 0xc4b8b8, 0xffffff].map(hex),
  base: 0.25,
  decay: 0.97,
  move: (v, _x, _y, radius, _angle, frame) => {
    if (radius < 0.85) {
      v.swirl = 0.12;
      v.rot = 0.02;
      v.zoom = 1.004;
      return;
    }
    v.zoom = 0.99 + 0.006 * Math.sin(radius * 20 - frame.time * 3);
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.3;
    ring(canvas, frame, 0.45, 0.35, 0.2, 0.25, Math.cos(a) * 0.3, Math.sin(a) * 0.1);
    ring(canvas, frame, 0.45, 0.35, 0.2, 0.25, -Math.cos(a) * 0.3, -Math.sin(a) * 0.1);
  },
});

const tornado = new Style({
  hue: 12,
  palette: [0x1c1612, 0x473b39, 0x877878, 0xc8bcbc, 0xffffff].map(hex),
  base: 0,
  decay: 0.98,
  edge: (_x, _y, radius) => (radius < 0.25 ? 0.7 : 1),
  move: (v) => {
    v.swirl = 0.15;
    v.zoom = 1.015;
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.8;
    const level = 0.5 + 0.3 * frame.audio.bassAtt;
    wave(canvas, frame, Math.cos(a) * 0.35, Math.sin(a) * 0.35, a + 1.5, 0.4, 0.2, 0, level);
    wave(canvas, frame, -Math.cos(a) * 0.35, -Math.sin(a) * 0.35, a + 1.5, 0.4, 0.2, 0.5, level);
  },
});

const backToTheGroove = new Style({
  hue: 5,
  palette: [0x10382e, 0x3c9480, 0x60b898, 0xb0c87a, 0xf0e868].map(hex),
  base: 0.25,
  decay: 0.995,
  move: (v) => {
    v.warp = 1.8;
    v.warpScale = 2;
    v.warpSpeed = 0.6;
    v.rot = 0.006;
  },
  draw: (canvas, frame) => {
    canvas.glow(0.1, 0.1, 0.6, 0.03 + 0.03 * frame.audio.bassAtt, 0, 0);
    wave(canvas, frame, 0, 0.1, frame.time * 0.2, 1.4, 0.3, 0, 0.3);
  },
});

const battery = (name: string, styles: ReadonlyArray<Style>) =>
  ambienceFamily("Battery", name, styles);

export const batteryBrightsphere = battery("brightsphere", [brightsphere]);
export const batteryFreakyCircles = battery("dance of the freaky circles", [freakyCircles]);
export const batteryCominatcha = battery("cominatcha", [cominatcha]);
export const batteryCottonstar = battery("cottonstar", [cottonstar]);
export const batteryDandelionaid = battery("dandelionaid", [dandelionaid]);
export const batteryDrinkdeep = battery("drinkdeep", [drinkdeep]);
export const batteryEletriarnation = battery("eletriarnation", [eletriarnation]);
export const batteryEventHorizon = battery("event horizon", [eventHorizon]);
export const batteryHizodge = battery("hizodge", [hizodge]);
export const batteryGemstonematrix = battery("gemstonematrix", [gemstonematrix]);
export const batterySepiaswirl = battery("sepiaswirl", [sepiaswirl]);
export const batteryIlluminator = battery("illuminator", [illuminator]);
export const batteryISeeTheTruth = battery("i see the truth", [iSeeTheTruth]);
export const batteryKaleidovision = battery("kaleidovision", [kaleidovision]);
export const batteryChemicalnova = battery("chemicalnova", [chemicalnova]);
export const batteryLotus = battery("lotus", [lotus]);
export const batteryGreenEnemy = battery("green is not your enemy", [greenEnemy]);
export const batteryRelativelyCalm = battery("relatively calm", [relativelyCalm]);
export const batterySleepyspray = battery("sleepyspray", [sleepyspray]);
export const batterySmokeOrWater = battery("smoke or water?", [smokeOrWater]);
export const batterySpiders = battery("spider's last moment...", [spiders]);
export const batteryStrawberryaid = battery("strawberryaid", [strawberryaid]);
export const batteryTheWorld = battery("the world", [theWorld]);
export const batteryTornado = battery("my tornado is resting", [tornado]);
export const batteryBackToTheGroove = battery("back to the groove", [backToTheGroove]);
export const batteryRandomization = battery("Randomization", [
  brightsphere,
  freakyCircles,
  cominatcha,
  cottonstar,
  dandelionaid,
  drinkdeep,
  eletriarnation,
  eventHorizon,
  hizodge,
  gemstonematrix,
  sepiaswirl,
  illuminator,
  iSeeTheTruth,
  kaleidovision,
  chemicalnova,
  lotus,
  greenEnemy,
  relativelyCalm,
  sleepyspray,
  smokeOrWater,
  spiders,
  strawberryaid,
  theWorld,
  tornado,
  backToTheGroove,
]);
