import { Color, type Motion } from "../canvas.ts";
import { type Frame, Preset } from "../preset.ts";

/**
 * A circular waveform and orbiting lights at the center; the feedback zooms and turns them into
 * an endless spiral tunnel, like a Milkdrop zoom preset
 */
export const tunnel = new Preset({
  name: "Tunnel",
  bloom: 0.8,
  create: (canvas) => {
    const points = 160;
    const color = new Color();
    let spin = 0;
    let turn = 0;
    // Outer parts move faster, which bends the walls into a tunnel
    const deepen = (vertex: Motion, _x: number, _y: number, radius: number) => {
      vertex.zoom *= 1 + 0.08 * radius;
    };

    return (frame: Frame) => {
      const { audio, dt, time, palette } = frame;
      const motion = frame.motion.reset();
      motion.decay = 0.965;
      motion.zoom = 1.035 + 0.035 * Math.min(2, audio.bassAtt) + 0.06 * audio.beatPulse;
      turn += dt * (0.25 + 0.35 * (audio.midAtt - 1));
      motion.rot = 0.025 * Math.sin(turn) + 0.012 * Math.sin(time * 0.37);
      motion.warp = 0.4 + 0.3 * audio.trebleAtt;
      motion.warpSpeed = 1.4;
      motion.cx = 0.12 * Math.sin(time * 0.23);
      motion.cy = 0.08 * Math.cos(time * 0.19);
      canvas.warp(motion, time, dt, deepen);

      const wave = audio.waveform;
      const step = wave.length / points;
      const base = 0.1 + 0.04 * Math.min(2, audio.bassAtt);
      spin += dt * (0.6 + audio.trebleAtt * 0.5);
      let lastX = 0;
      let lastY = 0;
      for (let i = 0; i <= points; i++) {
        // Mirrored halves close the ring without a seam
        const k = i <= points / 2 ? i : points - i;
        const value = wave[Math.floor(k * 2 * step) % wave.length] ?? 0;
        const angle = (i / points) * Math.PI * 2 + spin;
        const radius = base + value * 0.05;
        const px = motion.cx + Math.cos(angle) * radius;
        const py = motion.cy + Math.sin(angle) * radius;
        if (i > 0) {
          palette.sample(time * 0.04 + i / points, color, 0.7);
          canvas.line(lastX, lastY, px, py, color.r, color.g, color.b);
        }
        lastX = px;
        lastY = py;
      }

      for (let k = 0; k < 3; k++) {
        const angle = spin * 1.7 + (k * Math.PI * 2) / 3;
        const radius = 0.22 + 0.05 * Math.sin(time * 0.8 + k);
        palette.sample(time * 0.04 + k / 3 + 0.5, color, 0.35 + 0.4 * audio.trebleAtt);
        canvas.glow(
          motion.cx + Math.cos(angle) * radius,
          motion.cy + Math.sin(angle) * radius,
          0.012 + 0.01 * audio.treble,
          color.r,
          color.g,
          color.b,
        );
      }
    };
  },
});
