import { Color } from "../../canvas.ts";

/** A fixed sRGB color such as `0xffa500` */
export const hex = (value: number) =>
  new Color().set(((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255);

const out = new Color();

/** Sets `out` to the color at `t` from 0 to 1 on evenly spaced `stops` */
export const gradient = (stops: ReadonlyArray<Color>, t: number, out: Color) => {
  const position = Math.min(1, Math.max(0, t)) * (stops.length - 1);
  const index = Math.min(stops.length - 2, Math.floor(position));
  const a = stops[index] ?? out;
  const b = stops[index + 1] ?? a;
  const f = position - index;
  return out.set(a.r + (b.r - a.r) * f, a.g + (b.g - a.g) * f, a.b + (b.b - a.b) * f);
};

/** Fills a `Canvas.ramp` from `color(t, out)`, which sets `out` for the level `t` from 0 to 1 */
export const toRamp = (
  color: (t: number, out: Color) => void,
  ramp = new Float32Array(256 * 3),
) => {
  for (let i = 0; i < 256; i++) {
    color(i / 255, out);
    ramp[i * 3] = Math.min(1, Math.max(0, out.r));
    ramp[i * 3 + 1] = Math.min(1, Math.max(0, out.g));
    ramp[i * 3 + 2] = Math.min(1, Math.max(0, out.b));
  }
  return ramp;
};
