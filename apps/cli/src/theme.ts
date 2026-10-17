import type { NativeImage } from "@opentui/core";
import { Data } from "effect";

/** Hue in degrees, saturation and lightness from 0 to 1 */
export class Hsl extends Data.Class<{
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
}> {}

const toHsl = (red: number, green: number, blue: number) => {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const lightness = (max + min) / 2;
  const chroma = max - min;
  if (chroma === 0) return new Hsl({ hue: 0, saturation: 0, lightness });

  const saturation = chroma / (1 - Math.abs(2 * lightness - 1));
  const hue = () => {
    if (max === r) return (((g - b) / chroma + 6) % 6) * 60;
    if (max === g) return ((b - r) / chroma + 2) * 60;
    return ((r - g) / chroma + 4) * 60;
  };
  return new Hsl({ hue: hue(), saturation, lightness });
};

const toHex = (color: Hsl) => {
  const chroma = (1 - Math.abs(2 * color.lightness - 1)) * color.saturation;
  const channel = (offset: number) => {
    const k = (offset + color.hue / 30) % 12;
    const value = color.lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
};

/** Colors of the player, all from one accent color */
export class Theme extends Data.Class<{
  readonly accent: string;
  readonly background: string;
  readonly panel: string;
  readonly selection: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
}> {}

const defaultAccent = new Hsl({ hue: 222, saturation: 0.85, lightness: 0.72 });

export const themeFor = (accent: Hsl | null) => {
  const base = accent ?? defaultAccent;
  // The surfaces take only the hue, so that every accent reads well on them
  const tint = (saturation: number, lightness: number) =>
    toHex(new Hsl({ hue: base.hue, saturation: base.saturation * saturation, lightness }));

  return new Theme({
    accent: toHex(
      new Hsl({
        hue: base.hue,
        saturation: Math.max(base.saturation, 0.45),
        lightness: Math.min(Math.max(base.lightness, 0.62), 0.78),
      }),
    ),
    background: tint(0.35, 0.07),
    panel: tint(0.3, 0.11),
    selection: tint(0.45, 0.22),
    text: tint(0.15, 0.92),
    muted: tint(0.15, 0.62),
    faint: tint(0.25, 0.3),
  });
};

const hueBins = 12;

/**
 * The most common colorful hue of the image, or `null` for a gray image. Gray, dark and light
 * pixels do not count, so that a black border does not decide the color.
 */
export const artworkAccent = (image: NativeImage) => {
  const small = image.resize({ width: 24, height: 24 });
  const raw = small.raw("rgba8");
  const bins = () => Array.from({ length: hueBins }, () => 0);
  const weights = bins();
  const hues = bins();
  const saturations = bins();
  const lightnesses = bins();

  for (let y = 0; y < raw.height; y++) {
    for (let x = 0; x < raw.width; x++) {
      const index = y * raw.stride + x * 4;
      const red = raw.data[index] ?? 0;
      const green = raw.data[index + 1] ?? 0;
      const blue = raw.data[index + 2] ?? 0;
      const color = toHsl(red, green, blue);
      if (color.saturation < 0.2 || color.lightness < 0.15 || color.lightness > 0.9) continue;

      // Each pixel counts by its saturation, so that strong colors win over pale ones
      const bin = Math.floor(color.hue / (360 / hueBins)) % hueBins;
      const weight = color.saturation;
      weights[bin] = (weights[bin] ?? 0) + weight;
      hues[bin] = (hues[bin] ?? 0) + color.hue * weight;
      saturations[bin] = (saturations[bin] ?? 0) + color.saturation * weight;
      lightnesses[bin] = (lightnesses[bin] ?? 0) + color.lightness * weight;
    }
  }
  small.dispose();

  const best = weights.indexOf(Math.max(...weights));
  const weight = weights[best] ?? 0;
  // A few colorful pixels in a gray image are noise
  if (weight < raw.width * raw.height * 0.03) return null;

  return new Hsl({
    hue: (hues[best] ?? 0) / weight,
    saturation: (saturations[best] ?? 0) / weight,
    lightness: (lightnesses[best] ?? 0) / weight,
  });
};
