import type { Canvas } from "../../canvas.ts";
import { type Frame, Preset } from "../../preset.ts";
import { hex, toRamp } from "./color.ts";

const collection = "Bars and Waves";
const lime = hex(0xa4eb0c);
const cap = hex(0xdfeaf7);
// Level 1 is a bar and any other level above 0 is a cap
const barRamp = toRamp((t, out) => {
  const color = t === 1 ? lime : cap;
  out.set(t === 0 ? 0 : color.r, t === 0 ? 0 : color.g, t === 0 ? 0 : color.b);
});
const barCount = 47;

const fillRect = (
  canvas: Canvas,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  level: number,
) => {
  const pixels = canvas.pixels;
  for (let y = Math.max(0, y0); y < Math.min(canvas.height, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(canvas.width, x1); x++) {
      pixels[(y * canvas.width + x) * 3] = level;
    }
  }
};

// Edges of the bars in FFT bins on the mel scale, linear in the bass and logarithmic above 1 kHz
const barEdges = (bins: number) =>
  Float32Array.from({ length: barCount + 1 }, (_, i) => {
    const hz = 700 * (10 ** ((i / barCount) * Math.log10(1 + 16000 / 700)) - 1);
    return Math.max(1, (hz / 22050) * bins);
  });

const follow = (current: number, target: number, dt: number, attack: number, release: number) =>
  current + (target - current) * (1 - Math.exp(-dt / (target > current ? attack : release)));

const height = (level: number) => Math.min(1, Math.max(0, (level - 0.1) / 0.6));

export const bars = new Preset({
  name: "Bars",
  collection,
  bloom: 0,
  create: (canvas) => {
    const levels = new Float32Array(barCount);
    const peaks = new Float32Array(barCount);
    const holds = new Float32Array(barCount);
    let edges = barEdges(0);
    canvas.ramp = barRamp;

    return (frame: Frame) => {
      const { audio, dt } = frame;
      const spectrum = audio.spectrum;
      if (edges[barCount] !== (16000 / 22050) * spectrum.length) edges = barEdges(spectrum.length);
      canvas.pixels.fill(0);
      const h = canvas.height;
      const step = Math.max(2, Math.round(h / 50));
      const capHeight = Math.max(1, Math.round(h / 270));
      const left = Math.round((canvas.width - barCount * step) / 2);
      for (let i = 0; i < barCount; i++) {
        const from = Math.floor(edges[i] ?? 1);
        const to = Math.max(from + 1, Math.floor(edges[i + 1] ?? 1));
        // Mean power, so that a few loud bins lift the whole bar
        let sum = 0;
        for (let b = from; b < to; b++) sum += 10 ** ((spectrum[b] ?? 0) * 5.4);
        const mean = Math.log10(sum / (to - from)) / 5.4;
        const level = follow(levels[i] ?? 0, mean, dt, 0.03, 0.3);
        levels[i] = level;
        const hold = (holds[i] ?? 0) + dt;
        const peak =
          level >= (peaks[i] ?? 0) ? level : (peaks[i] ?? 0) - (hold > 0.4 ? 0.4 * dt : 0);
        holds[i] = level >= (peaks[i] ?? 0) ? 0 : hold;
        peaks[i] = peak;

        const x = left + i * step;
        const top = Math.round(h * (1 - height(level)));
        fillRect(canvas, x, top, x + step - 1, h, 1);
        const capY = Math.round(h * (1 - height(peak)));
        if (capY < top - capHeight) fillRect(canvas, x, capY - capHeight, x + step - 1, capY, 0.5);
      }
    };
  },
});

/**
 * A filled spectrum with one column per pixel. Its top fades through the ramp below the full
 * color at 1; `fade` is the ramp step per 1/30 s, and `mist` turns every second faded pixel gray.
 */
const spectrum = (name: string, fade: number, mist: boolean, color: Parameters<typeof toRamp>[0]) =>
  new Preset({
    name,
    collection,
    bloom: 0,
    create: (canvas) => {
      canvas.ramp = toRamp(color);
      const w = canvas.width;
      const h = canvas.height;
      const tops = new Int32Array(w).fill(h);
      const levels = new Float32Array(w);

      return (frame: Frame) => {
        const { spectrum } = frame.audio;
        const pixels = canvas.pixels;
        const d = fade * Math.min(4, frame.dt * 30);
        // Faded pixels stay above 0.5; mist pixels are below it
        const bottom = mist ? 0.5 : d;
        for (let o = 0; o < pixels.length; o += 3) {
          const v = pixels[o] ?? 0;
          if (v === 0) continue;
          const next = v - d;
          const floor = v >= 0.5 ? bottom : 0;
          pixels[o] = next < floor ? 0 : next;
        }

        const bins = Math.min(spectrum.length - 1, 743);
        for (let x = 0; x < w; x++) {
          let level = 0;
          if (bins > 1) {
            const from = Math.floor(bins ** (x / w));
            const to = Math.max(from + 1, Math.floor(bins ** ((x + 1) / w)));
            let sum = 0;
            for (let b = Math.max(1, from - 1); b <= to; b++)
              sum += 10 ** ((spectrum[b] ?? 0) * 5.4);
            level = Math.log10(sum / (to - Math.max(1, from - 1) + 1)) / 5.4;
          }
          const smooth = follow(levels[x] ?? 0, level, frame.dt, 0.03, 0.12);
          levels[x] = smooth;
          const top = Math.round(h * (1 - Math.min(1, Math.max(0, (smooth - 0.05) / 0.8))));
          // Only a fast drop leaves mist
          if (mist && top - (tops[x] ?? 0) > h / 60) {
            for (let y = tops[x] ?? 0; y < top; y++) {
              if (((x + y) & 1) === 1) pixels[(y * w + x) * 3] = 0.3;
            }
          }
          tops[x] = top;
          for (let y = top; y < h; y++) pixels[(y * w + x) * 3] = 1;
        }
      };
    },
  });

export const oceanMist = spectrum("Ocean Mist", 0.5 / 12, true, (t, out) => {
  if (t >= 0.5) out.set(0, 0, (t - 0.5) / 0.5);
  else out.set(t / 0.49, t / 0.49, t / 0.49);
});

export const fireStorm = spectrum("Fire Storm", 1 / 17, false, (t, out) => {
  const k = (1 - t) * 17;
  out.set((255 - 15 * k) / 255, Math.max(0, 165 - 15 * k) / 255, 0);
});

export const scope = new Preset({
  name: "Scope",
  collection,
  bloom: 0,
  create: (canvas) => {
    canvas.ramp = toRamp((t, out) => out.set(lime.r * t, lime.g * t, lime.b * t));
    return (frame: Frame) => {
      const wave = frame.audio.waveform;
      canvas.pixels.fill(0);
      const points = Math.min(wave.length, canvas.width);
      const gain = 1 / canvas.detail;
      let lastX = 0;
      let lastY = 0;
      for (let i = 0; i < points; i++) {
        const x = ((i / (points - 1)) * 2 - 1) * canvas.aspect;
        const y = (wave[Math.floor((i / points) * wave.length)] ?? 0) * 0.5;
        if (i > 0) canvas.line(lastX, lastY, x, y, gain, 0, 0);
        lastX = x;
        lastY = y;
      }
    };
  },
});
