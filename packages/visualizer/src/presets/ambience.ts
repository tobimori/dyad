import { Color, type Motion } from "../canvas.ts";
import { type Frame, Preset } from "../preset.ts";

const blobs = 7;

/** Soft lights and a faint waveform feed a slow flow field, which folds them into marbled smoke */
export const ambience = new Preset({
  name: "Ambience",
  bloom: 0.6,
  create: (canvas) => {
    const color = new Color();
    let flow = 0;
    const stir = (vertex: Motion, x: number, y: number) => {
      vertex.dx +=
        0.0045 * Math.sin(y * 3.1 + flow) + 0.0025 * Math.sin((x + y) * 5.3 - flow * 1.3);
      vertex.dy +=
        0.0045 * Math.cos(x * 2.7 - flow * 0.8) + 0.0025 * Math.cos((x - y) * 4.7 + flow);
    };

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      flow += dt * (0.15 + 0.2 * Math.min(2, audio.midAtt));
      const motion = frame.motion.reset();
      motion.decay = 0.972;
      motion.zoom = 1.002 + 0.004 * (audio.bassAtt - 1);
      motion.rot = 0.002 * Math.sin(time * 0.05);
      motion.warp = 0.6;
      motion.warpScale = 1.6;
      motion.warpSpeed = 0.5;
      canvas.warp(motion, time, dt, stir);

      const bands = audio.bands;
      for (let k = 0; k < blobs; k++) {
        const from = Math.floor((k / blobs) * bands.length);
        const to = Math.floor(((k + 1) / blobs) * bands.length);
        let level = 0;
        for (let b = from; b < to; b++) level += bands[b] ?? 0;
        level /= Math.max(1, to - from);
        const speed = 0.11 + k * 0.023;
        const x = Math.sin(time * speed * 1.3 + k * 2.1) * canvas.aspect * 0.75;
        const y = Math.cos(time * speed + k * 1.3) * 0.7;
        palette.sample(k / blobs + time * 0.008, color, 0.045 + 0.12 * level * level);
        canvas.glow(x, y, 0.1 + 0.1 * level, color.r, color.g, color.b);
      }

      const wave = audio.waveform;
      const angle = time * 0.07;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      palette.sample(time * 0.02 + 0.5, color, 0.07 + 0.06 * audio.trebleAtt);
      let lastX = 0;
      let lastY = 0;
      const points = 128;
      for (let i = 0; i < points; i++) {
        const u = (i / (points - 1)) * 2 - 1;
        const envelope = 1 - u * u;
        const v = (wave[Math.floor((i / points) * wave.length)] ?? 0) * 0.18 * envelope;
        const x = u * canvas.aspect * 0.8;
        const px = x * cos - v * sin;
        const py = x * sin + v * cos;
        if (i > 0) canvas.line(lastX, lastY, px, py, color.r, color.g, color.b);
        lastX = px;
        lastY = py;
      }
    };
  },
});
