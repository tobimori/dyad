import { Color } from "../../canvas.ts";
import { type Frame, Preset } from "../../preset.ts";
import { gradient, hex } from "./color.ts";
import { History } from "./history.ts";

const size = 48;
const levels = [0x600010, 0xa01050, 0x8030c0, 0x4060ff, 0xc0f0ff].map(hex);
const color = new Color();

const particle = (name: string, view: (time: number) => { yaw: number; pitch: number }) =>
  new Preset({
    name,
    collection: "Particle",
    bloom: 0,
    create: (canvas) => {
      const history = new History();
      return (frame: Frame) => {
        history.push(frame.audio.spectrum, 0.3 ** (frame.dt * 30));
        canvas.pixels.fill(0);
        const { yaw, pitch } = view(frame.time);
        const cy = Math.cos(yaw);
        const sy = Math.sin(yaw);
        const cp = Math.cos(pitch);
        const sp = Math.sin(pitch);
        for (let row = 0; row < size; row++) {
          for (let column = 0; column < size; column++) {
            // Rows are time from the front, columns are frequency from the back
            const level = history.at(row, (1 - column / (size - 1)) * 0.6);
            const x = column / (size - 1) - 0.5;
            const z = row / (size - 1) - 0.5;
            const y = -level * 0.4;
            const rx = x * cy - z * sy;
            const rz = x * sy + z * cy;
            const depth = 2 + rz * cp - y * sp;
            const k = 2.6 / depth;
            gradient(levels, level * 1.3, color);
            const gain = 2 * (0.4 + level);
            canvas.point(
              rx * k,
              (y * cp + rz * sp) * k + 0.1,
              color.r * gain,
              color.g * gain,
              color.b * gain,
            );
          }
        }
      };
    },
  });

export const particleParticle = particle("particle", () => ({ yaw: Math.PI / 4, pitch: -0.9 }));

export const particleRotating = particle("rotating particle", (time) => ({
  yaw: time * 0.4,
  pitch: -0.4 - 0.4 * Math.sin(time * 0.23),
}));
