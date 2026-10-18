import type { SourceSummary } from "@dyad/domain";
import {
  Analyzer,
  Picture,
  SampleRing,
  Visualizer,
  backdrops,
  graphicsSupport,
} from "@dyad/visualizer";
import type { Rgb } from "@dyad/visualizer";
import { KittyImage } from "@dyad/visualizer/kitty";
import { NodeServices } from "@effect/platform-node";
import type { OptimizedBuffer } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Effect, Random } from "effect";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Artwork } from "../component/use-artwork.ts";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import {
  Backdrop as BackdropStyle,
  Settings,
  updateSettings,
  useSettings,
} from "../context/settings.ts";
import { useTheme } from "../theme/theme.ts";
import { useToast } from "../ui/toast.tsx";
import { useKittyFiles } from "../video/video-view.tsx";
import { AudioFeed } from "./audio-feed.ts";
import type { AudioTap } from "./audio-feed.ts";
import { coverPalette, coverRgba, fallbackPalette } from "./visualizer-view.tsx";

const mode = graphicsSupport(process.env);
const imageId = 0x5d1a80;
const styles = BackdropStyle.literals;
const defaultStyle = "artwork";
const presetList = styles.flatMap((style) => (style === "off" ? [] : [backdrops[style]]));
const frameMs = 1000 / 30;
// Pixels for each cell; cells are about twice as high as wide
const cellPixels = { x: 2, y: 4 };
// Ghostty 1.3.1 draws a z-index below 0 under the text but over all cell backgrounds, so the
// image is transparent where a cell has a background of its own
const imageZ = -1;
// The effect stays dark, so that faint text on it stays readable
const brightness = 0.55;
const shadow = { columns: 3, rows: 1, depth: 0.85 };

/**
 * The saved effect style, `null` while the settings load or without Kitty graphics, and the key
 * that changes it. The view lists the key with its own keys, so that the hint shows before the
 * general ones.
 */
export function useBackdropStyle() {
  const toast = useToast();
  const files = useKittyFiles();
  const [settings, setSettings] = useSettings();
  const supported = mode === "kitty" && files === true;
  const style = settings === null || !supported ? null : (settings.backdrop ?? defaultStyle);

  const cycle = () => {
    if (settings === null || style === null) return;
    const next = styles[(styles.indexOf(style) + 1) % styles.length];
    if (next === undefined) return;
    setSettings(new Settings({ ...settings, backdrop: next }));
    toast("notice", next === "off" ? "Effect off" : `Effect: ${backdrops[next].name}`);
    Effect.runFork(
      updateSettings((current) => new Settings({ ...current, backdrop: next })).pipe(
        Effect.ignore,
        Effect.provide(NodeServices.layer),
      ),
    );
  };
  const keys: ReadonlyArray<readonly [Command, () => void]> =
    style === null ? [] : [[commands.backdrop, cycle]];
  return { style, commands: keys };
}

/**
 * An effect from the audio and the cover under `children`, in the Kitty graphics layer below the
 * text. Cells with a background of their own, such as panels, hide it; a dialog veil dims it.
 */
export function Backdrop(props: {
  /** `null` shows no effect */
  readonly style: typeof BackdropStyle.Type | null;
  readonly source: SourceSummary | undefined;
  readonly artwork: Artwork | null;
  readonly playing: boolean;
  readonly tap: () => AudioTap | null;
  readonly positionMs: () => number;
  readonly children: ReactNode;
}) {
  const renderer = useRenderer();
  const theme = useTheme();
  const latest = useRef(props);
  latest.current = props;
  const shown = useRef<Visualizer | null>(null);
  const colors = useRef<ReadonlyArray<Rgb>>([]);
  const picture = useRef<Picture | null>(null);
  const [size, setSize] = useState({ x: 0, y: 0, width: 0, height: 0 });

  // `off` is the last style, so the other styles have the index of their preset
  const preset = props.style === null || props.style === "off" ? -1 : styles.indexOf(props.style);
  const active = preset >= 0;

  const sourceId = props.source?.id ?? "";
  useEffect(() => {
    const artwork = props.artwork;
    colors.current = artwork === null ? fallbackPalette(sourceId) : coverPalette(artwork);
    const small = artwork === null ? null : coverRgba(artwork, 16);
    picture.current =
      small === null ? null : Picture.fromRgba(small.rgba, small.width, small.height);
    shown.current?.setPalette(colors.current);
    shown.current?.setPicture(picture.current);
  }, [props.artwork, sourceId]);

  useEffect(() => {
    if (!active || !props.playing) return;
    renderer.requestLive();
    return () => renderer.dropLive();
  }, [active, props.playing]);

  useEffect(() => {
    if (preset >= 0) shown.current?.select(preset);
  }, [preset]);

  useEffect(() => {
    const { x, y, width: columns, height: rows } = size;
    if (!active || columns <= 0 || rows <= 0) return;

    const width = columns * cellPixels.x;
    const height = rows * cellPixels.y;
    const visualizer = new Visualizer(width, height, presetList, Effect.runSync(Random.nextInt));
    visualizer.autoAdvance = 0;
    visualizer.setPalette(colors.current);
    visualizer.setPicture(picture.current);
    visualizer.select(preset);
    shown.current = visualizer;

    const kitty = new KittyImage(imageId, columns, rows, imageZ);
    const feed = new AudioFeed();
    const analyzer = new Analyzer();
    const silence = new SampleRing(1);
    const channels = (hex: string) =>
      [1, 3, 5, 7].map((start) => Number.parseInt(hex.slice(start, start + 2) || "ff", 16));
    const background = channels(theme.background);
    // A dialog blends this color over the screen; the effect under it gets the same blend
    const [veilR = 0, veilG = 0, veilB = 0, veilA = 255] = channels(theme.backdrop);
    const veilAlpha = veilA / 255;
    const veiled = [veilR, veilG, veilB].map(
      (value, i) => (background[i] ?? 0) * (1 - veilAlpha) + value * veilAlpha,
    );
    // Per cell: 1 for text, 2 for a background of its own, else 0
    const kinds = new Uint8Array(columns * rows).fill(255);
    const gains = new Float32Array(columns * rows);
    const output = new Uint8Array(width * height * 4);
    let veil = false;
    let sinceFrame = frameMs;
    let rendered = false;

    // Text gets a soft shadow: the effect is dim under it and brightens over a few cells
    const shade = (row: number, column: number) => {
      let field = 0;
      for (let dy = -shadow.rows; dy <= shadow.rows; dy++) {
        const r = row + dy;
        if (r < 0 || r >= rows) continue;
        for (let dx = -shadow.columns; dx <= shadow.columns; dx++) {
          const c = column + dx;
          if (c < 0 || c >= columns || kinds[r * columns + c] !== 1) continue;
          const distance = Math.hypot(dx / (shadow.columns + 1), dy / (shadow.rows + 1));
          field = Math.max(field, 1 - distance);
        }
      }
      return brightness * (1 - shadow.depth * Math.min(1, field * 1.6));
    };
    // Returns true when a cell changed
    const readCells = (buffer: OptimizedBuffer) => {
      const { char, bg } = buffer.buffers;
      const stride = buffer.width;
      const near = (cell: number, color: ReadonlyArray<number>) =>
        Math.abs((bg[cell * 4] ?? 0) - (color[0] ?? 0)) <= 2 &&
        Math.abs((bg[cell * 4 + 1] ?? 0) - (color[1] ?? 0)) <= 2 &&
        Math.abs((bg[cell * 4 + 2] ?? 0) - (color[2] ?? 0)) <= 2;
      let changed = false;
      let veiledCells = 0;
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          const cell = (y + row) * stride + x + column;
          const code = char[cell] ?? 0;
          const open = near(cell, background);
          const under = !open && near(cell, veiled);
          if (under) veiledCells++;
          const blank = code === 0 || code === 0x20;
          const kind = open || under ? Number(!blank) : 2;
          if (kinds[row * columns + column] !== kind) changed = true;
          kinds[row * columns + column] = kind;
        }
      }
      if (veil !== veiledCells > 0) changed = true;
      veil = veiledCells > 0;
      if (!changed) return false;
      for (let row = 0; row < rows; row++) {
        for (let column = 0; column < columns; column++) {
          gains[row * columns + column] = shade(row, column);
        }
      }
      return true;
    };

    const draw = (buffer: OptimizedBuffer, deltaMs: number) => {
      const { playing, tap, positionMs } = latest.current;
      sinceFrame += deltaMs;
      const due = !rendered || (playing && sinceFrame >= frameMs - 2);
      // The video renders at 60 frames a second, but the effect needs only every second frame
      if (playing && !due) return;
      const changed = readCells(buffer);
      if (!due && !changed) return;

      if (due) {
        const dt = sinceFrame / 1000;
        sinceFrame = 0;
        rendered = true;
        const tapped = playing ? tap() : null;
        const audio =
          tapped === null
            ? analyzer.update(silence, 0, dt)
            : analyzer.update(feed.ring, feed.update(tapped, positionMs()), dt);
        visualizer.render(audio, dt);
      }

      // The gain is smooth between cell centers, but a cell with its own background stays sharp
      const rgba = visualizer.rgba;
      for (let py = 0; py < height; py++) {
        const fy = Math.min(rows - 1, Math.max(0, (py + 0.5) / cellPixels.y - 0.5));
        const r0 = Math.floor(fy);
        const r1 = Math.min(rows - 1, r0 + 1);
        const ty = fy - r0;
        const row = Math.floor(py / cellPixels.y);
        for (let px = 0; px < width; px++) {
          const o = (py * width + px) * 4;
          if (kinds[row * columns + Math.floor(px / cellPixels.x)] === 2) {
            output[o + 3] = 0;
            continue;
          }
          const fx = Math.min(columns - 1, Math.max(0, (px + 0.5) / cellPixels.x - 0.5));
          const c0 = Math.floor(fx);
          const c1 = Math.min(columns - 1, c0 + 1);
          const tx = fx - c0;
          const value =
            ((gains[r0 * columns + c0] ?? 0) * (1 - tx) + (gains[r0 * columns + c1] ?? 0) * tx) *
              (1 - ty) +
            ((gains[r1 * columns + c0] ?? 0) * (1 - tx) + (gains[r1 * columns + c1] ?? 0) * tx) *
              ty;
          const keep = veil ? value * (1 - veilAlpha) : value;
          output[o] = (rgba[o] ?? 0) * keep + (veil ? veilR * veilAlpha : 0);
          output[o + 1] = (rgba[o + 1] ?? 0) * keep + (veil ? veilG * veilAlpha : 0);
          output[o + 2] = (rgba[o + 2] ?? 0) * keep + (veil ? veilB * veilAlpha : 0);
          output[o + 3] = 255;
        }
      }
      // TTY writes are synchronous on Linux and macOS, so the frame file is free after
      process.stdout.write(
        `\x1b7\x1b[${y + 1};${x + 1}H${kitty.encodeFile(output, width, height)}\x1b8`,
      );
    };
    renderer.addPostProcessFn(draw);
    renderer.requestRender();

    return () => {
      renderer.removePostProcessFn(draw);
      process.stdout.write(kitty.delete());
      kitty.removeFiles();
      feed.close();
      shown.current = null;
    };
  }, [active, size, theme.background, theme.backdrop]);

  return (
    <box
      flexGrow={1}
      onSizeChange={function () {
        setSize({ x: this.x, y: this.y, width: this.width, height: this.height });
      }}
    >
      {props.children}
    </box>
  );
}
