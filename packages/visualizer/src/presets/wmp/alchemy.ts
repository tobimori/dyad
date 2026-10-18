import { Color } from "../../canvas.ts";
import { type Frame, Preset, type Random } from "../../preset.ts";
import { hex } from "./color.ts";

const backgrounds = [0x6e1428, 0x3c8c3c, 0x6e6e28, 0x5064a0, 0x3c463c, 0x503c78, 0x8c1e3c].map(hex);
const pastels = [0x40ffff, 0x80ff40, 0xff40a0, 0xa060ff, 0xff9030, 0xffff40, 0xff5050].map(hex);
const figureCount = 6;

/** Wire shapes over a slowly changing color that morph every few seconds */
export const alchemyRandom = new Preset({
  name: "Random",
  collection: "Alchemy",
  bloom: 0,
  create: (canvas, random: Random) => {
    const background = new Color();
    let target = backgrounds[0] ?? background;
    let first = pastels[0] ?? background;
    let second = pastels[1] ?? background;
    let figure = 0;
    let mirror = false;
    let zoom = 1;
    let rot = 0;
    let warp = 0;
    let drift = 0;
    let points = 5;
    let left = 0;
    let since = 0;
    background.set(target.r, target.g, target.b);

    const morph = () => {
      figure = Math.floor(random.next() * figureCount);
      mirror = random.next() < 0.6;
      zoom = random.range(0.99, 1.04);
      rot = mirror ? 0 : random.range(-0.02, 0.02);
      warp = random.range(0, 1.5);
      drift = random.next() < 0.25 ? random.range(-0.01, 0.01) : 0;
      points = 4 + Math.floor(random.next() * 6);
      first = pastels[Math.floor(random.next() * pastels.length)] ?? first;
      second = pastels[Math.floor(random.next() * pastels.length)] ?? second;
      if (random.next() < 0.7)
        target = backgrounds[Math.floor(random.next() * backgrounds.length)] ?? target;
      left = random.range(4, 9);
      since = 0;
    };
    morph();

    let gain = 1;
    const line = (x0: number, y0: number, x1: number, y1: number, color: Color, level: number) => {
      const r = color.r * level * gain;
      const g = color.g * level * gain;
      const b = color.b * level * gain;
      canvas.line(x0, y0, x1, y1, r, g, b);
      if (!mirror) return;
      canvas.line(-x0, y0, -x1, y1, r, g, b);
      canvas.line(x0, -y0, x1, -y1, r, g, b);
      canvas.line(-x0, -y0, -x1, -y1, r, g, b);
    };
    const circle = (x: number, y: number, radius: number, color: Color, level: number) => {
      for (let i = 0; i < 16; i++) {
        const a0 = (i / 16) * Math.PI * 2;
        const a1 = ((i + 1) / 16) * Math.PI * 2;
        line(
          x + Math.cos(a0) * radius,
          y + Math.sin(a0) * radius,
          x + Math.cos(a1) * radius,
          y + Math.sin(a1) * radius,
          color,
          level,
        );
      }
    };

    return (frame: Frame) => {
      const { audio, dt, time } = frame;
      left -= dt;
      since += dt;
      if (left <= 0 || (since > 3 && audio.beatPulse > 0.95 && random.next() < 0.1)) morph();

      const motion = frame.motion.reset();
      motion.decay = 1;
      motion.zoom = zoom + 0.01 * audio.beatPulse;
      motion.rot = rot;
      motion.warp = warp;
      motion.dx = drift;
      canvas.warp(motion, time, dt);

      // Trails fade into the background color instead of to black
      const fade = 1 - Math.exp(-dt / 0.5);
      const step = 1 - Math.exp(-dt / 6);
      background.set(
        background.r + (target.r - background.r) * step,
        background.g + (target.g - background.g) * step,
        background.b + (target.b - background.b) * step,
      );
      const pixels = canvas.pixels;
      for (let o = 0; o < pixels.length; o += 3) {
        const r = Math.min(1.2, pixels[o] ?? 0);
        const g = Math.min(1.2, pixels[o + 1] ?? 0);
        const b = Math.min(1.2, pixels[o + 2] ?? 0);
        pixels[o] = r + (background.r - r) * fade;
        pixels[o + 1] = g + (background.g - g) * fade;
        pixels[o + 2] = b + (background.b - b) * fade;
      }

      gain = 0.13 / canvas.detail;
      const size = 0.35 + 0.4 * Math.min(1.5, audio.volume);
      const level = 0.4 + 0.6 * Math.min(1, audio.volume);
      const wave = audio.waveform;
      const bands = audio.bands;
      const spin = time * 0.6;
      const x0 = mirror ? 0.4 : 0.6 * Math.sin(time * 0.31);
      const y0 = mirror ? 0.3 : 0.4 * Math.cos(time * 0.23);

      if (figure === 0) {
        for (let k = 0; k < 4; k++) {
          const radius = size * (0.6 + k * 0.15);
          const color = k % 2 === 0 ? first : second;
          for (let i = 0; i < points; i++) {
            const a0 = spin + k * 0.08 + (i / points) * Math.PI * 2;
            const a1 = spin + k * 0.08 + (((i + 2) % points) / points) * Math.PI * 2;
            line(
              x0 + Math.cos(a0) * radius,
              y0 + Math.sin(a0) * radius,
              x0 + Math.cos(a1) * radius,
              y0 + Math.sin(a1) * radius,
              color,
              level,
            );
          }
        }
      } else if (figure === 1) {
        for (let i = 0; i < 40; i++) {
          const u = i / 39;
          const x = (u * 2 - 1) * canvas.aspect * 0.9;
          const a = u * Math.PI * 4 + spin * 2;
          const y = 0.3 * Math.sin(u * Math.PI * 2 + time * 0.4);
          const h = size * 0.6 * Math.sin(a);
          line(x, y - h, x + 0.03, y + h, i % 2 === 0 ? first : second, level * 0.8);
        }
      } else if (figure === 2) {
        const count = 48;
        for (let i = 0; i < count; i++) {
          const a = spin + (i / count) * Math.PI * 2;
          const tilt = Math.sin(a * 3 + time);
          const length = size * (0.4 + 0.8 * (bands[(i * 3) % bands.length] ?? 0));
          line(
            x0,
            y0,
            x0 + Math.cos(a) * length,
            y0 + Math.sin(a) * length * (0.6 + 0.4 * tilt),
            i % 2 === 0 ? first : second,
            level,
          );
        }
      } else if (figure === 3) {
        const fx = -canvas.aspect * 0.8;
        const fy = 0.8;
        for (let i = 0; i < 24; i++) {
          const u = i / 23;
          const tx = Math.cos(spin * 0.5 + u * 2) * canvas.aspect * 0.8;
          const ty = -0.8 + 0.4 * Math.sin(time * 0.7 + u * 3);
          line(fx, fy, tx, ty, u < 0.5 ? first : second, level * 0.7);
        }
      } else if (figure === 4) {
        const ax = Math.cos(time * 0.37) * canvas.aspect * 0.8;
        const ay = Math.sin(time * 0.29) * 0.7;
        const bx = -ax;
        const by = -ay;
        const n = 64;
        let px = ax;
        let py = ay;
        for (let i = 1; i <= n; i++) {
          const u = i / n;
          const v = (wave[Math.floor(u * (wave.length - 1))] ?? 0) * 0.06;
          const x = ax + (bx - ax) * u - (by - ay) * v;
          const y = ay + (by - ay) * u + (bx - ax) * v;
          line(px, py, x, y, second, level);
          px = x;
          py = y;
        }
        for (let k = 0; k < 3; k++) {
          const u = (time * 0.2 + k / 3) % 1;
          circle(ax + (bx - ax) * u, ay + (by - ay) * u, 0.05 + 0.04 * audio.bassAtt, first, level);
        }
      } else {
        const length = canvas.aspect;
        const n = 96;
        for (let i = 1; i < n; i++) {
          const u0 = ((i - 1) / (n - 1)) * 2 - 1;
          const u1 = (i / (n - 1)) * 2 - 1;
          const v0 = (wave[Math.floor(((i - 1) / n) * wave.length)] ?? 0) * 0.08;
          const v1 = (wave[Math.floor((i / n) * wave.length)] ?? 0) * 0.08;
          line(u0 * length, v0, u1 * length, v1, first, level);
          line(v0, u0, v1, u1, second, level);
        }
        circle(size, 0, 0.08 * size, second, level);
        circle(0, size * 0.7, 0.08 * size, first, level);
      }
    };
  },
});
