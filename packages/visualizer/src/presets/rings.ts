import { Color } from "../canvas.ts";
import { type Frame, Preset } from "../preset.ts";

const ringCount = 3;

/** Battery-style waveform rings that turn in opposite directions and leave echo trails */
export const rings = new Preset({
  name: "Rings",
  bloom: 0.7,
  create: (canvas) => {
    const points = 200;
    const color = new Color();
    const angles = new Float32Array(ringCount);
    let kick = 0;

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      const motion = frame.motion.reset();
      motion.decay = 0.9;
      motion.zoom = 1.018 + 0.01 * Math.sin(time * 0.3);
      motion.rot = 0.02 * Math.sin(time * 0.21);
      motion.sx = 1 + 0.01 * Math.sin(time * 0.5);
      motion.warp = 0.15;
      canvas.warp(motion, time, dt);

      kick = Math.max(kick * Math.exp(-dt / 0.15), audio.beatPulse);
      const wave = audio.waveform;
      for (let ring = 0; ring < ringCount; ring++) {
        const direction = ring % 2 === 0 ? 1 : -1;
        const angle =
          (angles[ring] ?? 0) + direction * dt * (0.4 + 0.25 * ring) * (0.6 + audio.midAtt * 0.6);
        angles[ring] = angle;
        const base = 0.2 + ring * 0.2 + 0.05 * kick;
        const depth = 0.05 + 0.03 * ring;
        const offset = ring * 97;
        palette.sample(time * 0.03 + ring / ringCount, color, 0.75 + 0.25 * audio.volume);
        let lastX = 0;
        let lastY = 0;
        for (let i = 0; i <= points; i++) {
          // Mirrored halves close the ring without a seam
          const k = i <= points / 2 ? i : points - i;
          const value = wave[(offset + k * 2) % wave.length] ?? 0;
          const theta = (i / points) * Math.PI * 2 + angle;
          const radius = base + value * depth;
          const px = Math.cos(theta) * radius;
          const py = Math.sin(theta) * radius;
          if (i > 0) canvas.line(lastX, lastY, px, py, color.r, color.g, color.b);
          lastX = px;
          lastY = py;
        }
      }
    };
  },
});
