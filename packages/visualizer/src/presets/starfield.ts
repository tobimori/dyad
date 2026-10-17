import { Color, type Motion } from "../canvas.ts";
import { type Frame, Preset } from "../preset.ts";

/** Stars fly at the viewer as streaks; the bass sets the speed and a beat kicks a warp swirl */
export const starfield = new Preset({
  name: "Starfield",
  bloom: 1,
  create: (canvas, random) => {
    const count = 900;
    const x = new Float32Array(count);
    const y = new Float32Array(count);
    const z = new Float32Array(count);
    const tint = new Float32Array(count);
    const color = new Color();
    const spread = canvas.aspect * 1.2;
    const spawn = (i: number, depth: number) => {
      x[i] = random.range(-spread, spread);
      y[i] = random.range(-1.2, 1.2);
      z[i] = depth;
      tint[i] = random.next();
    };
    for (let i = 0; i < count; i++) spawn(i, random.range(0.05, 1));
    let roll = 0;
    let swirl = 0;
    let speed = 0.3;
    // The swirl turns the center more than the edges, like a warp jump
    const twist = (vertex: Motion, _x: number, _y: number, radius: number) => {
      vertex.rot += swirl * Math.exp(-radius * 2.5);
    };

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      if (audio.beat) swirl = (audio.beats % 2 === 0 ? 1 : -1) * 0.08;
      swirl *= Math.exp(-dt / 0.35);
      const target = 0.25 + 0.45 * Math.min(2.5, audio.bassAtt) + 1.6 * audio.beatPulse;
      speed += (target - speed) * (1 - Math.exp(-dt / 0.12));
      roll += dt * (0.05 + 0.1 * (audio.midAtt - 1));

      const motion = frame.motion.reset();
      motion.decay = 0.8;
      motion.zoom = 1.03 + 0.1 * audio.beatPulse;
      canvas.warp(motion, time, dt, twist);

      const cos = Math.cos(roll);
      const sin = Math.sin(roll);
      const lens = 0.55;
      for (let i = 0; i < count; i++) {
        const before = z[i] ?? 1;
        const after = before - speed * dt;
        const sx = x[i] ?? 0;
        const sy = y[i] ?? 0;
        const ax = (sx / before) * lens;
        const ay = (sy / before) * lens;
        const bx = (sx / after) * lens;
        const by = (sy / after) * lens;
        if (after < 0.02 || Math.abs(bx) > canvas.aspect * 1.5 || Math.abs(by) > 1.5) {
          spawn(i, random.range(0.8, 1));
          continue;
        }
        z[i] = after;
        const near = 1 - after;
        palette.sample((tint[i] ?? 0) * 0.3 + time * 0.02, color, near * near * 2.4);
        // Stars are mostly white with a palette tint
        const white = near * near * near * 1.2;
        const r = color.r * 0.6 + white;
        const g = color.g * 0.6 + white;
        const b = color.b * 0.6 + white;
        canvas.line(
          ax * cos - ay * sin,
          ax * sin + ay * cos,
          bx * cos - by * sin,
          bx * sin + by * cos,
          r,
          g,
          b,
        );
      }

      palette.sample(time * 0.03, color, 0.03 + 0.05 * audio.bassAtt);
      canvas.glow(0, 0, 0.3, color.r, color.g, color.b);
      palette.sample(time * 0.03 + 0.5, color, 0.03 + 0.15 * audio.beatPulse);
      canvas.glow(0, 0, 0.08, color.r, color.g, color.b);
    };
  },
});
