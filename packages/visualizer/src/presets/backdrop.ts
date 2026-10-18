import { Color, type Motion } from "../canvas.ts";
import { type Frame, type Picture, Preset } from "../preset.ts";

// Large palette lights drift through a slow flow field; the bass swells them, a beat lifts them
const aura = new Preset({
  name: "Aura",
  bloom: 0.5,
  create: (canvas) => {
    const color = new Color();
    let flow = 0;
    let swell = 0;
    const stir = (vertex: Motion, x: number, y: number) => {
      vertex.dx += 0.003 * Math.sin(y * 2.3 + flow);
      vertex.dy += 0.003 * Math.cos(x * 1.9 - flow * 0.7);
    };

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      flow += dt * (0.1 + 0.15 * Math.min(2, audio.midAtt));
      swell = Math.max(swell * Math.exp(-dt / 0.4), audio.beatPulse);
      const motion = frame.motion.reset();
      motion.decay = 0.93;
      motion.zoom = 1.001 + 0.008 * swell;
      motion.warp = 0.4;
      motion.warpScale = 1.2;
      motion.warpSpeed = 0.3;
      canvas.warp(motion, time, dt, stir);

      const bass = Math.min(2.5, audio.bassAtt);
      for (let k = 0; k < 4; k++) {
        const speed = 0.05 + k * 0.017;
        const x = Math.sin(time * speed + k * 1.7) * canvas.aspect * 0.7;
        const y = Math.cos(time * speed * 1.3 + k * 2.3) * 0.6;
        palette.sample(k / 4 + time * 0.01, color, 0.045 + 0.025 * bass + 0.08 * swell);
        canvas.glow(x, y, 0.45 + 0.1 * bass + 0.1 * swell, color.r, color.g, color.b);
      }
    };
  },
});

// Mirrored repeat, so that a turned and moved copy of the picture has no seams
const mirror = (t: number) => {
  const wrapped = t - Math.floor(t / 2) * 2;
  return wrapped > 1 ? 2 - wrapped : wrapped;
};

const sample = (picture: Picture, u: number, v: number, out: Color) => {
  const { width, height, pixels } = picture;
  const x = mirror(u) * (width - 1);
  const y = mirror(v) * (height - 1);
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(width - 1, x0 + 1);
  const y1 = Math.min(height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = (y0 * width + x0) * 3;
  const b = (y0 * width + x1) * 3;
  const c = (y1 * width + x0) * 3;
  const d = (y1 * width + x1) * 3;
  const wa = (1 - fx) * (1 - fy);
  const wb = fx * (1 - fy);
  const wc = (1 - fx) * fy;
  const wd = fx * fy;
  return out.set(
    (pixels[a] ?? 0) * wa + (pixels[b] ?? 0) * wb + (pixels[c] ?? 0) * wc + (pixels[d] ?? 0) * wd,
    (pixels[a + 1] ?? 0) * wa +
      (pixels[b + 1] ?? 0) * wb +
      (pixels[c + 1] ?? 0) * wc +
      (pixels[d + 1] ?? 0) * wd,
    (pixels[a + 2] ?? 0) * wa +
      (pixels[b + 2] ?? 0) * wb +
      (pixels[c + 2] ?? 0) * wc +
      (pixels[d + 2] ?? 0) * wd,
  );
};

// Two large, turning copies of the blurred cover, like animated album art. The bass and beats
// brighten them. Without a cover, the palette makes the gradient.
const artwork = new Preset({
  name: "Artwork",
  bloom: 0.25,
  create: (canvas) => {
    const first = new Color();
    const second = new Color();
    let pulse = 0;

    return (frame: Frame) => {
      const { audio, dt, time, palette, picture } = frame;
      pulse = Math.max(pulse * Math.exp(-dt / 0.3), audio.beatPulse);
      const gain = 0.5 + 0.15 * Math.min(2, audio.bassAtt) + 0.3 * pulse;
      const layers = [
        { angle: time * 0.021, zoom: 0.5 + 0.05 * Math.sin(time * 0.07), ox: 0.5, oy: 0.5 },
        { angle: 1.3 - time * 0.017, zoom: 0.75 + 0.08 * Math.sin(time * 0.05), ox: 0.3, oy: 0.6 },
      ].map((layer) => ({
        ...layer,
        cos: Math.cos(layer.angle) * layer.zoom,
        sin: Math.sin(layer.angle) * layer.zoom,
        ox: layer.ox + 0.2 * Math.sin(time * 0.013 + layer.oy),
        oy: layer.oy + 0.2 * Math.cos(time * 0.011 + layer.ox),
      }));
      const [a, b] = layers;
      if (a === undefined || b === undefined) return;

      const { width, height, pixels } = canvas;
      const half = height / 2;
      for (let py = 0; py < height; py++) {
        const y = (py - half) / half;
        for (let px = 0; px < width; px++) {
          const x = (px - width / 2) / half;
          const o = (py * width + px) * 3;
          const au = x * a.cos - y * a.sin + a.ox;
          const av = x * a.sin + y * a.cos + a.oy;
          const bu = x * b.cos - y * b.sin + b.ox;
          const bv = x * b.sin + y * b.cos + b.oy;
          if (picture === null) {
            palette.sample(au * 0.25 + av * 0.15 + time * 0.01, first);
            palette.sample(bu * 0.2 - bv * 0.2 + 0.5, second);
          } else {
            sample(picture, au, av, first);
            sample(picture, bu, bv, second);
          }
          const r = (first.r + second.r) * 0.55;
          const g = (first.g + second.g) * 0.55;
          const bl = (first.b + second.b) * 0.55;
          // Blur takes saturation away, so it comes back here
          const luma = r * 0.3 + g * 0.55 + bl * 0.15;
          pixels[o] = Math.max(0, luma + (r - luma) * 1.5) * gain;
          pixels[o + 1] = Math.max(0, luma + (g - luma) * 1.5) * gain;
          pixels[o + 2] = Math.max(0, luma + (bl - luma) * 1.5) * gain;
        }
      }
    };
  },
});

const ringCount = 12;
const ringPoints = 128;

// Each beat sends a ring out from the center through a zooming trail; the bass lights the core
const pulse = new Preset({
  name: "Pulse",
  bloom: 0.8,
  create: (canvas) => {
    const radius = new Float32Array(ringCount);
    const strength = new Float32Array(ringCount);
    const hue = new Float32Array(ringCount);
    const color = new Color();
    let next = 0;
    let quiet = 0;
    let kick = 0;

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      kick = Math.max(kick * Math.exp(-dt / 0.2), audio.beatPulse);
      const motion = frame.motion.reset();
      motion.decay = 0.86;
      motion.zoom = 1.012 + 0.025 * kick;
      motion.rot = 0.003 * Math.sin(time * 0.2);
      canvas.warp(motion, time, dt);

      quiet += dt;
      // Without beats, for example while the audio plays on another device, slow rings go on
      if (audio.beat || quiet > 1.2) {
        radius[next] = 0.05;
        strength[next] = audio.beat ? 0.7 + 0.3 * Math.min(1.5, audio.bassAtt - 0.5) : 0.5;
        hue[next] = time * 0.05;
        next = (next + 1) % ringCount;
        quiet = 0;
      }

      for (let ring = 0; ring < ringCount; ring++) {
        const level = strength[ring] ?? 0;
        if (level < 0.01) continue;
        const r = (radius[ring] ?? 0) + dt * (0.45 + (radius[ring] ?? 0) * 0.7);
        radius[ring] = r;
        strength[ring] = level * Math.exp(-dt / 0.9);
        palette.sample(hue[ring] ?? 0, color, level * 2.4);
        let lastX = r;
        let lastY = 0;
        for (let i = 1; i <= ringPoints; i++) {
          const theta = (i / ringPoints) * Math.PI * 2;
          const x = Math.cos(theta) * r;
          const y = Math.sin(theta) * r;
          canvas.line(lastX, lastY, x, y, color.r, color.g, color.b);
          lastX = x;
          lastY = y;
        }
      }

      palette.sample(time * 0.02, color, 0.015 + 0.02 * Math.min(2.5, audio.bassAtt) + 0.06 * kick);
      canvas.glow(0, 0, 0.35 + 0.15 * kick, color.r, color.g, color.b);
    };
  },
});

// Embers rise from the bottom and fade; the bass lifts them faster, the treble makes them flicker
const embers = new Preset({
  name: "Embers",
  bloom: 0.8,
  create: (canvas, random) => {
    const count = 420;
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const rise = new Float32Array(count);
    const phase = new Float32Array(count);
    const tint = new Float32Array(count);
    const color = new Color();
    const spread = canvas.aspect * 1.1;
    const spawn = (i: number, top: number) => {
      x[i] = random.range(-spread, spread);
      y[i] = random.range(top, 1.1);
      rise[i] = random.range(0.04, 0.13);
      phase[i] = random.range(0, Math.PI * 2);
      tint[i] = random.next();
    };
    for (let i = 0; i < count; i++) spawn(i, -1.1);
    let lift = 1;

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      const motion = frame.motion.reset();
      motion.decay = 0.82;
      motion.dy = -0.002;
      canvas.warp(motion, time, dt);

      const target = 0.6 + 0.5 * Math.min(2.5, audio.bassAtt) + 2.5 * audio.beatPulse;
      lift += (target - lift) * (1 - Math.exp(-dt / 0.15));
      const sparkle = 0.6 + 0.5 * Math.min(2, audio.trebleAtt);
      for (let i = 0; i < count; i++) {
        const py = (y[i] ?? 0) - (rise[i] ?? 0) * lift * dt;
        const p = phase[i] ?? 0;
        const px = (x[i] ?? 0) + Math.sin(time * 0.7 + p) * 0.03 * dt;
        if (py < -1.1) {
          spawn(i, 1.05);
          continue;
        }
        x[i] = px;
        y[i] = py;
        const fade = Math.min(1, (py + 1.1) / 1.6);
        const flicker = 0.65 + 0.35 * Math.sin(time * 5 + p * 3);
        palette.sample((tint[i] ?? 0) * 0.3, color, fade * flicker * sparkle * 2.5);
        // Every eighth ember is a large, soft one
        if (i % 8 === 0) {
          const size = 0.012 + 0.02 * (rise[i] ?? 0) * 10 * (0.7 + 0.3 * lift);
          canvas.glow(px, py, size, color.r * 0.3, color.g * 0.3, color.b * 0.3);
        } else {
          canvas.point(px, py, color.r, color.g, color.b);
        }
      }

      palette.sample(0.1 + time * 0.01, color, 0.012 + 0.012 * Math.min(2.5, audio.bassAtt));
      canvas.glow(0, 1.2, 0.8, color.r, color.g, color.b);
    };
  },
});

// The spectrum as a mirrored skyline on a horizon line, with a reflection and rising haze
const horizon = new Preset({
  name: "Horizon",
  bloom: 0.7,
  create: (canvas) => {
    const color = new Color();
    const line = 0.45;

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      const motion = frame.motion.reset();
      motion.decay = 0.78;
      motion.dy = -0.004;
      motion.warp = 0.15;
      canvas.warp(motion, time, dt);

      const bands = audio.bands;
      const count = bands.length;
      let total = 0;
      for (let i = 0; i < count; i++) total += bands[i] ?? 0;
      // A slow wave stands in for silence, for example while the audio plays on another device
      const silent = total < 0.01 * count;
      for (let i = 0; i < count; i++) {
        const level = silent
          ? 0.05 + 0.04 * Math.sin(time * 1.3 + i * 0.4)
          : Math.min(1, (bands[i] ?? 0) * 1.2);
        const height = 0.03 + level * 0.75;
        palette.sample((i / count) * 0.6 + time * 0.02, color, 0.8 + level);
        for (const side of [-1, 1]) {
          const px = side * ((i + 0.5) / count) * canvas.aspect * 0.95;
          canvas.line(px, line, px, line - height, color.r, color.g, color.b);
          canvas.line(
            px,
            line,
            px,
            line + height * 0.45,
            color.r * 0.3,
            color.g * 0.3,
            color.b * 0.3,
          );
        }
      }
      palette.sample(time * 0.02, color, 0.6);
      canvas.line(-canvas.aspect, line, canvas.aspect, line, color.r, color.g, color.b);
    };
  },
});

/** Presets for a background behind text: dark, few hard edges, and motion also in silence */
export const backdrops = { aura, artwork, pulse, embers, horizon };
