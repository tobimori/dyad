import { Data } from "effect";

import type { Canvas, Color, Motion } from "../../canvas.ts";
import { type Frame, Preset, type Random } from "../../preset.ts";
import { hex, toRamp } from "./color.ts";

// The hue order of WMP 9 Ambience
const hues = [
  0x5a78ff, 0xd82818, 0xff8c20, 0xffff00, 0x30b030, 0x40f0f0, 0x5a78ff, 0x2828e0, 0xe028e0,
  0xf078b4, 0x8c5ae6, 0xfaaa78, 0xa0a0a0,
].map(hex);

class Style extends Data.Class<{
  /** Index in `hues` of the first color, as in the first run on Windows XP */
  readonly hue: number;
  /** Level that shows as the darkest color, so that the background keeps a dark tint */
  readonly base: number;
  readonly decay: number;
  /** Number of dark and light bands across the levels, 0 for one smooth ramp */
  readonly bands?: number;
  /** Multiplier for the level at a point after the warp, for dark edges and holes */
  readonly edge?: (x: number, y: number, radius: number) => number;
  readonly move: (
    vertex: Motion,
    x: number,
    y: number,
    radius: number,
    angle: number,
    frame: Frame,
  ) => void;
  readonly draw: (canvas: Canvas, frame: Frame) => void;
}> {}

/**
 * Draws the waveform as a jagged line through (`cx`, `cy`) in the direction `angle`. `start`
 * selects the part of the waveform, so that two lines differ.
 */
const wave = (
  canvas: Canvas,
  frame: Frame,
  cx: number,
  cy: number,
  angle: number,
  length: number,
  amplitude: number,
  start = 0,
  level = 1,
) => {
  const samples = frame.audio.waveform;
  const points = Math.max(
    8,
    Math.min(samples.length >> 1, Math.round(length * canvas.scale * 0.7)),
  );
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const gain = level / canvas.detail;
  const offset = Math.floor(start * (samples.length >> 1));
  let lastX = 0;
  let lastY = 0;
  for (let i = 0; i < points; i++) {
    const u = (i / (points - 1) - 0.5) * length;
    const v = (samples[offset + Math.floor((i / points) * (samples.length >> 1))] ?? 0) * amplitude;
    const x = cx + u * cos - v * sin;
    const y = cy + u * sin + v * cos;
    if (i > 0) canvas.line(lastX, lastY, x, y, gain, 0, 0);
    lastX = x;
    lastY = y;
  }
};

/** Draws the waveform around a ring with the radii `rx` and `ry` */
const ring = (
  canvas: Canvas,
  frame: Frame,
  rx: number,
  ry: number,
  amplitude: number,
  level = 1,
) => {
  const samples = frame.audio.waveform;
  const points = Math.max(16, Math.min(samples.length, Math.round(rx * canvas.scale * 4)));
  const gain = level / canvas.detail;
  let lastX = 0;
  let lastY = 0;
  for (let i = 0; i <= points; i++) {
    const a = (i / points) * Math.PI * 2;
    const v = 1 + (samples[i % points] ?? 0) * amplitude;
    const x = Math.cos(a) * rx * v;
    const y = Math.sin(a) * ry * v;
    if (i > 0) canvas.line(lastX, lastY, x, y, gain, 0, 0);
    lastX = x;
    lastY = y;
  }
};

const swirl = new Style({
  hue: 7,
  base: 0.25,
  decay: 0.99,
  move: (v, x, y, _radius, angle, frame) => {
    const edge = 0.8 + 0.06 * Math.sin(angle * 7 + frame.time);
    const inside = Math.min(1, Math.max(0, (edge - Math.hypot(x / 1.35, y)) * 12 + 0.5));
    v.rot = 0.004 * inside - 0.03 * (1 - inside);
    v.zoom = 1 + 0.03 * inside - 0.006 * (1 - inside);
  },
  draw: (canvas, frame) => {
    wave(canvas, frame, 0, -0.5, 0, canvas.aspect * 2, 0.15, 0, 0.4);
    wave(canvas, frame, 0, 0.5, 0, canvas.aspect * 2, 0.15, 0.5, 0.4);
    // The zoom pulls the peaks of a small ring out into spokes
    ring(canvas, frame, 0.08, 0.08, 0.8, 0.12);
    canvas.glow(0, 0, 0.3, 0.008, 0, 0);
  },
});

const warp = new Style({
  hue: 0,
  base: 0.2,
  decay: 0.985,
  // A radial ripple in the zoom bunches the light into rings
  move: (v, _x, _y, radius, _angle, frame) => {
    v.zoom = 1.04 + 0.035 * Math.sin(radius * 16 - frame.time * 6);
    v.warp = 0.6;
    v.warpScale = 2;
  },
  draw: (canvas, frame) => ring(canvas, frame, 0.14, 0.14, 0.3, 0.8 + 0.6 * frame.audio.bassAtt),
});

const anon = new Style({
  hue: 3,
  base: 0.45,
  decay: 0.97,
  move: (v) => {
    v.zoom = 1.02;
    v.warp = 1.2;
    v.warpScale = 1.4;
  },
  draw: (canvas, frame) => wave(canvas, frame, 0, 0, 0, canvas.aspect * 2, 0.2),
});

const falloff = new Style({
  hue: 3,
  base: 0.25,
  decay: 0.985,
  // The center column pulls in from the top and bottom edges, which makes the dark hourglass
  move: (v, x) => {
    v.sy = 1.05 - 0.1 * Math.exp(-((x / 0.3) ** 2));
  },
  draw: (canvas, frame) => wave(canvas, frame, 0, 0, 0, canvas.aspect * 2, 0.12),
});

const water = new Style({
  hue: 3,
  base: 0.35,
  decay: 0.97,
  move: (v, _x, _y, radius, _angle, frame) => {
    v.zoom = 1.015 + 0.012 * Math.sin(radius * 14 - frame.time * 4);
    v.warp = 0.3;
  },
  draw: (canvas, frame) => {
    canvas.glow(0, 0, 0.25, 0.12 + 0.12 * frame.audio.bassAtt, 0, 0);
    wave(canvas, frame, 0, 0, 0, canvas.aspect * 1.6, 0.06, 0, 0.6);
  },
});

const bubble = new Style({
  hue: 3,
  base: 0,
  decay: 0.998,
  edge: (x, y) => {
    const d = (x / 1.05) ** 2 + (y / 0.88) ** 2;
    if (d > 1) return 0.6;
    return d < 0.015 ? 0.5 : 1;
  },
  move: (v, _x, _y, _radius, angle, frame) => {
    v.zoom = 0.975 + 0.01 * Math.sin(angle * 5 + frame.time);
    v.rot = 0.01;
  },
  draw: (canvas, frame) => ring(canvas, frame, 0.95, 0.8, 0.12),
});

const dizzy = new Style({
  hue: 8,
  base: 0.2,
  decay: 0.97,
  move: (v, _x, _y, _radius, _angle, frame) => {
    v.rot = 0.04 * Math.sin(frame.time * 0.6);
    v.sx = 1.01;
  },
  draw: (canvas, frame) => {
    const a = 0.25 * Math.sin(frame.time * 0.4);
    wave(canvas, frame, 0, -0.1, a, canvas.aspect * 2, 0.3, 0, 0.6);
    wave(canvas, frame, 0, 0.1, -a, canvas.aspect * 2, 0.3, 0.5, 0.6);
  },
});

const windmill = new Style({
  hue: 5,
  base: 0.3,
  decay: 0.96,
  move: (v) => {
    v.zoom = 1.01;
    v.rot = 0.004;
    v.warp = 0.4;
    v.warpScale = 1.5;
  },
  draw: (canvas, frame) => {
    const a = 0.5 + frame.time * 0.05;
    const nx = -Math.sin(a);
    const ny = Math.cos(a);
    for (let k = -1; k <= 1; k++) {
      wave(
        canvas,
        frame,
        nx * k * 0.55,
        ny * k * 0.55,
        a,
        canvas.aspect * 2.4,
        0.12,
        (k + 1) / 3,
        0.6,
      );
    }
  },
});

const niagara = new Style({
  hue: 5,
  base: 0.3,
  decay: 0.97,
  // Water flows out of the center column and falls faster with distance
  move: (v, x) => {
    const out = Math.max(0, Math.abs(x) - 0.08);
    v.dx = Math.sign(x) * Math.min(0.015, out * 0.1);
    v.dy = 0.02 * out * out;
  },
  draw: (canvas, frame) => {
    const top = 0.6 - 1.2 * Math.min(1, frame.audio.volume);
    for (let k = -1; k <= 1; k++) {
      wave(canvas, frame, k * 0.025, (1 + top) / 2, Math.PI / 2, 1 - top, 0.03, 0.3 + k * 0.1, 0.5);
    }
    const bands = frame.audio.bands;
    for (let k = 0; k < 6; k++) {
      const y = -0.85 + k * 0.17;
      const level = (bands[k * 8] ?? 0) / canvas.detail;
      canvas.line(0.12, y, 0.4, y, level, 0, 0);
      canvas.line(-0.12, y, -0.4, y, level, 0, 0);
    }
  },
});

const blender = new Style({
  hue: 0,
  base: 0.2,
  decay: 0.99,
  edge: (_x, _y, radius) => (radius > 1.15 ? 0.85 : 1),
  move: (v) => {
    v.rot = 0.03;
    v.swirl = 0.15;
  },
  draw: (canvas, frame) => {
    wave(canvas, frame, 0, 0, 0, canvas.aspect * 2, 0.15, 0, 0.7);
    wave(canvas, frame, 0, 0.01, 0, canvas.aspect * 2, 0.15, 0, 0.7);
  },
});

const xMarks = new Style({
  hue: 9,
  base: 0.3,
  decay: 0.975,
  edge: (_x, _y, radius) => (radius > 1.35 ? 0.9 : 1),
  move: (v) => {
    v.zoom = 1.015;
    v.warp = 0.8;
    v.warpScale = 1.5;
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.08;
    wave(canvas, frame, 0, 0, a, canvas.aspect * 2.4, 0.12, 0, 0.6);
    wave(canvas, frame, 0, 0, a + Math.PI / 2, canvas.aspect * 2.4, 0.12, 0.5, 0.6);
  },
});

const drain = new Style({
  hue: 11,
  base: 0.15,
  decay: 0.99,
  move: (v) => {
    v.rot = 0.04;
    v.zoom = 0.995;
    v.swirl = 0.05;
  },
  draw: (canvas, frame) => {
    const a = frame.time * 0.25;
    const nx = -Math.sin(a) * 0.6;
    const ny = Math.cos(a) * 0.6;
    wave(canvas, frame, nx, ny, a + Math.PI / 2, 2.2, 0.1, 0, 0.7);
    wave(canvas, frame, -nx, -ny, a + Math.PI / 2, 2.2, 0.1, 0.5, 0.7);
  },
});

const thingus = new Style({
  hue: 3,
  base: 0.3,
  decay: 0.99,
  bands: 2,
  move: (v) => {
    v.swirl = 0.12;
    v.zoom = 0.995;
  },
  draw: (canvas, frame) => {
    const a = Math.PI / 4 + 0.3 * Math.sin(frame.time * 0.2);
    wave(canvas, frame, 0, 0, a, canvas.aspect * 2.4, 0.1);
    wave(canvas, frame, 0, 0, a + Math.PI / 2, canvas.aspect * 2.4, 0.1, 0.5);
    canvas.glow(0, 0, 0.15, 0.2, 0, 0);
  },
});

const styleSeconds = [10, 30] as const;
const hueSeconds = [10, 60] as const;
const hueFade = 3;

const ambience = (name: string, styles: ReadonlyArray<Style>) =>
  new Preset({
    name,
    collection: "Ambience",
    bloom: 0,
    create: (canvas, random: Random) => {
      const ramp = new Float32Array(256 * 3);
      canvas.ramp = ramp;
      const pick = () => styles[Math.floor(random.next() * styles.length)] ?? swirl;
      let style = pick();
      let styleLeft = random.range(...styleSeconds);
      let hue = styles.length > 1 ? Math.floor(random.next() * hues.length) : style.hue;
      let hueLeft = random.range(...hueSeconds);
      const edges = new Map<Style, Float32Array>();
      const edgeOf = (s: Style, edge: (x: number, y: number, radius: number) => number) => {
        const known = edges.get(s);
        if (known !== undefined) return known;
        const mask = new Float32Array(canvas.width * canvas.height);
        for (let py = 0; py < canvas.height; py++) {
          for (let px = 0; px < canvas.width; px++) {
            const x = (px - (canvas.width - 1) / 2) / canvas.scale;
            const y = (py - (canvas.height - 1) / 2) / canvas.scale;
            mask[py * canvas.width + px] = edge(x, y, Math.sqrt(x * x + y * y));
          }
        }
        edges.set(s, mask);
        return mask;
      };
      let current: Frame | undefined;
      const move = (v: Motion, x: number, y: number, radius: number, angle: number) => {
        if (current !== undefined) style.move(v, x, y, radius, angle, current);
      };

      return (frame: Frame) => {
        const { dt, time } = frame;
        current = frame;
        styleLeft -= dt;
        if (styleLeft <= 0 && styles.length > 1) {
          const next = pick();
          style = next === style ? pick() : next;
          styleLeft = random.range(...styleSeconds);
        }
        hueLeft -= dt;
        if (hueLeft <= -hueFade) {
          hue = (hue + 1) % hues.length;
          hueLeft = random.range(...hueSeconds);
        }
        const from = hues[hue] ?? hues[0];
        const to = hues[(hue + 1) % hues.length] ?? hues[0];
        const mix = Math.max(0, -hueLeft / hueFade);
        const base = style.base;
        const bands = style.bands ?? 0;
        toRamp((t, out: Color) => {
          const level = base + (1 - base) * t;
          const u = bands > 0 ? 0.5 - 0.5 * Math.cos(level * Math.PI * bands) : level;
          const r = (from?.r ?? 0) + ((to?.r ?? 0) - (from?.r ?? 0)) * mix;
          const g = (from?.g ?? 0) + ((to?.g ?? 0) - (from?.g ?? 0)) * mix;
          const b = (from?.b ?? 0) + ((to?.b ?? 0) - (from?.b ?? 0)) * mix;
          const dark = Math.min(1, u / 0.55);
          const white = Math.max(0, (u - 0.55) / 0.45);
          out.set(
            r * dark + (1 - r) * white,
            g * dark + (1 - g) * white,
            b * dark + (1 - b) * white,
          );
        }, ramp);

        const motion = frame.motion.reset();
        motion.decay = style.decay;
        canvas.warp(motion, time, dt, move);
        const pixels = canvas.pixels;
        const mask = style.edge === undefined ? undefined : edgeOf(style, style.edge);
        const keep = Math.min(4, dt * 30);
        // A cap keeps feedback from filling the image with white
        for (let o = 0; o < pixels.length; o += 3) {
          const level = Math.min(1.1, pixels[o] ?? 0);
          pixels[o] = mask === undefined ? level : level * (mask[o / 3] ?? 1) ** keep;
        }
        style.draw(canvas, frame);
      };
    },
  });

export const ambienceSwirl = ambience("Swirl", [swirl]);
export const ambienceWarp = ambience("Warp", [warp]);
export const ambienceAnon = ambience("Anon", [anon]);
export const ambienceFalloff = ambience("Falloff", [falloff]);
export const ambienceWater = ambience("Water", [water]);
export const ambienceBubble = ambience("Bubble", [bubble]);
export const ambienceDizzy = ambience("Dizzy", [dizzy]);
export const ambienceWindmill = ambience("Windmill", [windmill]);
export const ambienceNiagara = ambience("Niagara", [niagara]);
export const ambienceBlender = ambience("Blender", [blender]);
export const ambienceXMarks = ambience("X Marks the Spot", [xMarks]);
export const ambienceDrain = ambience("Down the Drain", [drain]);
export const ambienceThingus = ambience("Thingus", [thingus]);
export const ambienceRandom = ambience("Random", [
  swirl,
  warp,
  anon,
  falloff,
  water,
  bubble,
  dizzy,
  windmill,
  niagara,
  blender,
  xMarks,
  drain,
  thingus,
]);
