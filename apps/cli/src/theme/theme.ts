import type { NativeImage, TerminalColors } from "@opentui/core";
import { Data } from "effect";
import { createContext, useContext } from "react";

/** Hue in degrees, saturation and lightness from 0 to 1 */
export class Hsl extends Data.Class<{
  readonly hue: number;
  readonly saturation: number;
  readonly lightness: number;
}> {}

class Rgb extends Data.Class<{
  readonly red: number;
  readonly green: number;
  readonly blue: number;
}> {}

const toHsl = (color: Rgb) => {
  const r = color.red / 255;
  const g = color.green / 255;
  const b = color.blue / 255;
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

const toRgb = (color: Hsl) => {
  const chroma = (1 - Math.abs(2 * color.lightness - 1)) * color.saturation;
  const channel = (offset: number) => {
    const k = (offset + color.hue / 30) % 12;
    const value = color.lightness - (chroma / 2) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(value * 255);
  };
  return new Rgb({ red: channel(0), green: channel(8), blue: channel(4) });
};

const hexChannel = (value: number) =>
  Math.round(Math.min(255, Math.max(0, value)))
    .toString(16)
    .padStart(2, "0");

const toHex = (color: Rgb) =>
  `#${hexChannel(color.red)}${hexChannel(color.green)}${hexChannel(color.blue)}`;

const fromHex = (hex: string) => {
  const digits = hex.replace("#", "");
  const value = (start: number) => Number.parseInt(digits.slice(start, start + 2), 16);
  return new Rgb({ red: value(0), green: value(2), blue: value(4) });
};

// `amount` 0 gives `from`, 1 gives `to`
const mix = (from: Rgb, to: Rgb, amount: number) =>
  new Rgb({
    red: from.red + (to.red - from.red) * amount,
    green: from.green + (to.green - from.green) * amount,
    blue: from.blue + (to.blue - from.blue) * amount,
  });

/** `null` for a color that the terminal does not report */
export class TerminalScheme extends Data.Class<{
  readonly mode: "dark" | "light";
  readonly background: string | null;
  readonly foreground: string | null;
  /** ANSI blue, the accent when the cover has no color */
  readonly blue: string | null;
  readonly red: string | null;
}> {}

const hexOrNull = (value: string | null | undefined) =>
  value !== null && value !== undefined && /^#[0-9a-f]{6}$/i.test(value) ? value : null;

export const terminalScheme = (mode: "dark" | "light", colors: TerminalColors | null) =>
  new TerminalScheme({
    mode,
    background: hexOrNull(colors?.defaultBackground),
    foreground: hexOrNull(colors?.defaultForeground),
    blue: hexOrNull(colors?.palette[mode === "dark" ? 12 : 4]),
    red: hexOrNull(colors?.palette[mode === "dark" ? 9 : 1]),
  });

/** Components use only these roles, never a fixed color */
export class Theme extends Data.Class<{
  readonly accent: string;
  readonly background: string;
  readonly panel: string;
  readonly selection: string;
  readonly text: string;
  readonly muted: string;
  readonly faint: string;
  readonly error: string;
  /** Covers the screen behind a dialog */
  readonly backdrop: string;
}> {}

const defaults = {
  dark: { background: "#15171d", foreground: "#e4e6eb", red: "#f07178" },
  light: { background: "#fafafa", foreground: "#1f2328", red: "#c62828" },
};

const defaultAccent = new Hsl({ hue: 222, saturation: 0.85, lightness: 0.6 });

// The accent must read well as text on the background of the mode
const accentLightness = {
  dark: { minimum: 0.62, maximum: 0.78 },
  light: { minimum: 0.3, maximum: 0.45 },
};

const readableAccent = (color: Hsl, mode: "dark" | "light") => {
  const range = accentLightness[mode];
  return new Hsl({
    hue: color.hue,
    saturation: Math.max(color.saturation, 0.45),
    lightness: Math.min(Math.max(color.lightness, range.minimum), range.maximum),
  });
};

/** The surfaces come from the terminal, the accent from the cover or else from the terminal blue */
export const themeFor = (scheme: TerminalScheme, cover: Hsl | null) => {
  const fallback = defaults[scheme.mode];
  const background = fromHex(scheme.background ?? fallback.background);
  const foreground = fromHex(scheme.foreground ?? fallback.foreground);
  const terminalAccent = scheme.blue === null ? null : toHsl(fromHex(scheme.blue));
  const accent = toRgb(readableAccent(cover ?? terminalAccent ?? defaultAccent, scheme.mode));
  const dark = scheme.mode === "dark";

  return new Theme({
    accent: toHex(accent),
    background: toHex(background),
    panel: toHex(mix(mix(background, foreground, dark ? 0.05 : 0.04), accent, 0.03)),
    selection: toHex(mix(background, accent, dark ? 0.24 : 0.16)),
    text: toHex(foreground),
    muted: toHex(mix(foreground, background, 0.38)),
    faint: toHex(mix(foreground, background, 0.62)),
    error: scheme.red ?? fallback.red,
    backdrop: dark ? "#000000a0" : "#00000050",
  });
};

export const ThemeContext = createContext(
  themeFor(
    new TerminalScheme({ mode: "dark", background: null, foreground: null, blue: null, red: null }),
    null,
  ),
);

export const useTheme = () => useContext(ThemeContext);

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
      const color = toHsl(
        new Rgb({
          red: raw.data[index] ?? 0,
          green: raw.data[index + 1] ?? 0,
          blue: raw.data[index + 2] ?? 0,
        }),
      );
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
