import { Color } from "../canvas.ts";
import { type Frame, Preset } from "../preset.ts";

/**
 * Particles follow a slowly turning flow field at even speed and draw four mirrored copies of
 * their path, so the trails grow into symmetric, silky ribbons
 */
export const alchemy = new Preset({
  name: "Alchemy",
  bloom: 0.7,
  create: (canvas, random) => {
    const count = 600;
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const life = new Float32Array(count);
    const hue = new Float32Array(count);
    const color = new Color();
    const spawn = (i: number) => {
      const angle = random.next() * Math.PI * 2;
      const radius = Math.sqrt(random.next()) * 0.95;
      x[i] = Math.cos(angle) * radius * canvas.aspect;
      y[i] = Math.sin(angle) * radius;
      life[i] = random.range(2, 6);
      hue[i] = random.next();
    };
    for (let i = 0; i < count; i++) {
      spawn(i);
      life[i] = random.range(0, 6);
    }
    let drift = random.range(0, 100);
    let speed = 0.3;

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      const motion = frame.motion.reset();
      motion.decay = 0.95;
      motion.zoom = 0.998 + 0.006 * audio.beatPulse;
      motion.rot = 0.004 * Math.sin(time * 0.13);
      canvas.warp(motion, time, dt);

      drift += dt * (0.12 + 0.12 * Math.min(2, audio.midAtt));
      const target = 0.18 + 0.22 * Math.min(2.5, audio.bassAtt) + 0.5 * audio.beatPulse;
      speed += (target - speed) * (1 - Math.exp(-dt / 0.1));
      const step = speed * dt;
      const brightness = 0.09 + 0.07 * Math.min(2, audio.volume);
      for (let i = 0; i < count; i++) {
        const px = x[i] ?? 0;
        const py = y[i] ?? 0;
        const angle =
          2.1 * Math.sin(px * 1.4 + drift) +
          2.1 * Math.cos(py * 1.2 - drift * 0.8) +
          1.4 * Math.sin((px + py) * 0.8 + drift * 0.5);
        const nx = px + Math.cos(angle) * step;
        const ny = py + Math.sin(angle) * step;
        x[i] = nx;
        y[i] = ny;
        const left = (life[i] ?? 0) - dt;
        life[i] = left;
        if (left <= 0 || Math.abs(nx) > canvas.aspect || Math.abs(ny) > 1) {
          spawn(i);
          continue;
        }
        const fade = Math.min(1, left, (6 - left) * 2) * brightness;
        palette.sample((hue[i] ?? 0) * 0.3 + drift * 0.08, color, fade);
        canvas.line(px, py, nx, ny, color.r, color.g, color.b);
        canvas.line(-px, py, -nx, ny, color.r, color.g, color.b);
        canvas.line(px, -py, nx, -ny, color.r, color.g, color.b);
        canvas.line(-px, -py, -nx, -ny, color.r, color.g, color.b);
      }
    };
  },
});
