import { videoMaxHeight } from "@dyad/client-runtime";
import type { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import {
  Analyzer,
  CellGrid,
  Picture,
  SampleRing,
  Visualizer,
  backdrops,
  defaultPalettes,
  encodeHalfBlocks,
  encodeOctants,
  graphicsSupport,
  paletteFromImage,
  presets,
} from "@dyad/visualizer";
import type { Rgb } from "@dyad/visualizer";
import { KittyImage } from "@dyad/visualizer/kitty";
import { NodeServices } from "@effect/platform-node";
import { FrameBufferRenderable } from "@opentui/core";
import type { BoxRenderable, OptimizedBuffer } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Effect, Random } from "effect";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Artwork } from "../component/use-artwork.ts";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import {
  Backdrop as BackdropStyle,
  BackdropEffect,
  Overlay,
  Settings,
  updateSettings,
  useSettings,
} from "../context/settings.ts";
import { useTheme } from "../theme/theme.ts";
import { useToast } from "../ui/toast.tsx";
import { VideoPicture, copyCells, useKittyFiles } from "../video/video-view.tsx";
import { AudioFeed } from "./audio-feed.ts";
import type { AudioTap } from "./audio-feed.ts";

const mode = graphicsSupport(process.env);
const visualId = 0x5d1a80;
const shadeId = 0x5d1a81;
// Ghostty 1.3.1 draws a z-index below 0 under the text but over all cell backgrounds, so the
// backdrop is transparent where a cell has a background of its own. A shade lies over a video.
const backdropZ = -2;
const shadeZ = -1;
const defaultStyle = "artwork";
const effects = BackdropEffect.literals;
// The effects first, so that an effect has the index of its style in `effects`
const presetList = [...effects.map((style) => backdrops[style]), ...presets];
const frameMs = 1000 / 30;
const presetSeconds = 40;
const delayStepMs = 20;
// Pixels for each cell; cells are about twice as high as wide
const cellPixels = { x: 2, y: 4 };
// Under an overlay the backdrop stays dark, so that faint text on it stays readable
const brightness = 0.55;
const shadow = { columns: 3, rows: 1, depth: 0.85 };

/** Tracks without a cover still get their own colors */
const fallbackPalette = (key: string) => {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return defaultPalettes[hash % defaultPalettes.length] ?? [];
};

const coverRgba = (artwork: Artwork, size: number) => {
  const small = artwork.image.resize({ width: size, height: size });
  const raw = small.raw("rgba8");
  const rgba = new Uint8Array(raw.width * raw.height * 4);
  for (let y = 0; y < raw.height; y++) {
    rgba.set(raw.data.subarray(y * raw.stride, y * raw.stride + raw.width * 4), y * raw.width * 4);
  }
  small.dispose();
  return { rgba, width: raw.width, height: raw.height };
};

/**
 * The saved backdrop and overlay of the now playing view, and the keys that change them. A video
 * backdrop shows the default effect while the source has no video.
 */
export function useBackdrop(source: SourceSummary | undefined) {
  const toast = useToast();
  const [settings, setSettings] = useSettings();
  const [preset, setPreset] = useState(() =>
    Effect.runSync(Random.nextIntBetween(0, presets.length, { halfOpen: true })),
  );
  // A source ID, so that the effect shows for the rest of a source whose video failed
  const [failed, setFailed] = useState<string | null>(null);
  const restoredOverlay = useRef<typeof Overlay.Type>("full");

  const hasVideo = source?.video === true && failed !== source.id;
  const saved = settings?.backdrop ?? defaultStyle;
  const style = saved === "video" && !hasVideo ? defaultStyle : saved;
  const overlay = settings?.overlay ?? "full";
  if (overlay !== "none") restoredOverlay.current = overlay;
  const delayMs = settings?.videoDelayMs ?? 0;

  const save = (change: Partial<Settings>) => {
    if (settings === null) return;
    setSettings(new Settings({ ...settings, ...change }));
    Effect.runFork(
      updateSettings((current) => new Settings({ ...current, ...change })).pipe(
        Effect.ignore,
        Effect.provide(NodeServices.layer),
      ),
    );
  };

  const describe = (next: typeof BackdropStyle.Type, index: number) => {
    if (next === "off") return "Backdrop off";
    if (next === "video") return "Backdrop: video";
    if (next === "visualizer") return `Visualizer · ${presets[index]?.label ?? ""}`;
    return `Backdrop: ${backdrops[next].name}`;
  };
  const choices = BackdropStyle.literals.filter((each) => each !== "video" || hasVideo);
  const cycleBackdrop = () => {
    const next = choices[(choices.indexOf(style) + 1) % choices.length] ?? defaultStyle;
    save({ backdrop: next });
    toast("notice", describe(next, preset));
  };

  const overlayNames = {
    full: "Overlay: cover and details",
    details: "Overlay: details",
    none: "Overlay off",
  };
  const cycleOverlay = () => {
    const overlays = Overlay.literals;
    const next = overlays[(overlays.indexOf(overlay) + 1) % overlays.length] ?? "full";
    save({ overlay: next });
    toast("notice", overlayNames[next]);
  };

  const stepPreset = (step: number) => {
    const next = (preset + step + presets.length) % presets.length;
    setPreset(next);
    toast("notice", describe("visualizer", next));
  };

  const stepDelay = (stepMs: number) => {
    const next = Math.max(-2000, Math.min(2000, delayMs + stepMs));
    save({ videoDelayMs: next });
    if (next === 0) toast("notice", "Video in sync");
    else toast("notice", `Video ${Math.abs(next)} ms ${next > 0 ? "later" : "earlier"}`);
  };

  const styleKeys: ReadonlyArray<readonly [Command, () => void]> =
    style === "visualizer"
      ? [
          [commands.nextPreset, () => stepPreset(1)],
          [commands.previousPreset, () => stepPreset(-1)],
        ]
      : [];
  const videoKeys: ReadonlyArray<readonly [Command, () => void]> =
    style === "video"
      ? [
          [commands.videoLater, () => stepDelay(delayStepMs)],
          [commands.videoEarlier, () => stepDelay(-delayStepMs)],
        ]
      : [];
  const keys: ReadonlyArray<readonly [Command, () => void]> =
    settings === null
      ? []
      : [
          [commands.backdrop, cycleBackdrop],
          [commands.overlay, cycleOverlay],
          ...styleKeys,
          ...videoKeys,
        ];

  return {
    /** `null` while the settings load */
    style: settings === null ? null : style,
    overlay,
    preset,
    delayMs,
    commands: keys,
    /** Hides the overlay, or shows it again; without a backdrop the visualizer shows */
    showOnly: (only: boolean) =>
      save(
        only
          ? { overlay: "none", backdrop: style === "off" ? "visualizer" : style }
          : { overlay: restoredOverlay.current },
      ),
    watchVideo: () => save({ backdrop: "video", overlay: "none" }),
    nextPreset: () => setPreset((current) => (current + 1) % presets.length),
    videoFailed: (reason: string) => {
      if (source === undefined) return;
      setFailed(source.id);
      toast("notice", reason);
    },
  };
}

/**
 * The cells over the backdrop, read from the screen. Per cell: `kinds` is 1 for text, 2 for a
 * background of its own (`owns`), else 0; `gains` dims the backdrop to `base` and further under
 * text, for a soft shadow. `read` returns true when a cell changed.
 */
const screenCells = (
  area: { readonly x: number; readonly y: number; readonly columns: number; readonly rows: number },
  theme: { readonly background: string; readonly backdrop: string },
  base: number,
) => {
  const { x, y, columns, rows } = area;
  const channels = (hex: string) =>
    [1, 3, 5, 7].map((start) => Number.parseInt(hex.slice(start, start + 2) || "ff", 16));
  const background = channels(theme.background);
  // A dialog blends this color over the screen; the backdrop under it gets the same blend
  const [veilR = 0, veilG = 0, veilB = 0, veilA = 255] = channels(theme.backdrop);
  const veilAlpha = veilA / 255;
  const veiled = [veilR, veilG, veilB].map(
    (value, i) => (background[i] ?? 0) * (1 - veilAlpha) + value * veilAlpha,
  );
  const cells = {
    kinds: new Uint8Array(columns * rows).fill(255),
    owns: new Uint8Array(columns * rows * 3),
    gains: new Float32Array(columns * rows),
    veil: false,
    veilColor: [veilR, veilG, veilB],
    veilAlpha,
  };
  const { kinds, owns, gains } = cells;

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
    return base * (1 - shadow.depth * Math.min(1, field * 1.6));
  };

  const read = (buffer: OptimizedBuffer) => {
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
        const at = row * columns + column;
        const code = char[cell] ?? 0;
        const open = near(cell, background);
        const under = !open && near(cell, veiled);
        if (under) veiledCells++;
        const blank = code === 0 || code === 0x20;
        const kind = open || under ? Number(!blank) : 2;
        if (kinds[at] !== kind) changed = true;
        kinds[at] = kind;
        for (let channel = 0; channel < 3; channel++) {
          const own = kind === 2 ? (bg[cell * 4 + channel] ?? 0) : 0;
          if (owns[at * 3 + channel] !== own) changed = true;
          owns[at * 3 + channel] = own;
        }
      }
    }
    if (cells.veil !== veiledCells > 0) changed = true;
    cells.veil = veiledCells > 0;
    if (!changed) return false;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        gains[row * columns + column] = shade(row, column);
      }
    }
    return true;
  };

  // The gain is smooth between cell centers, but a cell with a background of its own stays sharp
  const pixel = (px: number, py: number) => {
    const fy = Math.min(rows - 1, Math.max(0, (py + 0.5) / cellPixels.y - 0.5));
    const r0 = Math.floor(fy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = fy - r0;
    const fx = Math.min(columns - 1, Math.max(0, (px + 0.5) / cellPixels.x - 0.5));
    const c0 = Math.floor(fx);
    const c1 = Math.min(columns - 1, c0 + 1);
    const tx = fx - c0;
    return (
      ((gains[r0 * columns + c0] ?? 0) * (1 - tx) + (gains[r0 * columns + c1] ?? 0) * tx) *
        (1 - ty) +
      ((gains[r1 * columns + c0] ?? 0) * (1 - tx) + (gains[r1 * columns + c1] ?? 0) * tx) * ty
    );
  };

  return Object.assign(cells, { read, pixel });
};

// TTY writes are synchronous on Linux and macOS, so a frame file and a buffer are free after
const writeAt = (x: number, y: number, escape: string | Uint8Array) => {
  process.stdout.write(`\x1b7\x1b[${y + 1};${x + 1}H`);
  process.stdout.write(escape);
  process.stdout.write("\x1b8");
};

/**
 * The backdrop of the now playing view under `children`. With Kitty graphics it is an image below
 * the text that is dim under text, transparent under cells with a background of their own and
 * veiled under a dialog. Cells show it only without an overlay.
 */
export function Backdrop(props: {
  /** `null` shows no backdrop */
  readonly style: typeof BackdropStyle.Type | null;
  readonly overlay: typeof Overlay.Type;
  /** The index in `presets` for the visualizer */
  readonly preset: number;
  readonly source: SourceSummary | undefined;
  readonly artwork: Artwork | null;
  readonly playing: boolean;
  readonly tap: () => AudioTap | null;
  readonly positionMs: () => number;
  readonly connection: typeof ServerConnection.Service | null;
  readonly serverUrl: string;
  readonly delayMs: number;
  readonly onPresetEnd: () => void;
  readonly onVideoFailure: (reason: string) => void;
  readonly children: ReactNode;
}) {
  const renderer = useRenderer();
  const theme = useTheme();
  const files = useKittyFiles();
  const latest = useRef(props);
  latest.current = props;
  const host = useRef<BoxRenderable | null>(null);
  const shown = useRef<Visualizer | null>(null);
  const colors = useRef<ReadonlyArray<Rgb>>([]);
  const picture = useRef<Picture | null>(null);
  const sincePreset = useRef(0);
  const [size, setSize] = useState({ x: 0, y: 0, width: 0, height: 0 });

  const graphics = mode === "kitty" && files !== undefined;
  const style = props.style;
  const shows =
    style !== null &&
    style !== "off" &&
    (graphics || (mode !== "kitty" && props.overlay === "none"));
  const index =
    style === "visualizer"
      ? effects.length + props.preset
      : effects.findIndex((effect) => effect === style);
  const visual = shows && index >= 0;
  const video = shows && style === "video";
  const indexRef = useRef(index);
  indexRef.current = index;
  const base = props.overlay === "none" ? 1 : brightness;

  const sourceId = props.source?.id ?? "";
  useEffect(() => {
    const artwork = props.artwork;
    const large = artwork === null ? null : coverRgba(artwork, 48);
    colors.current =
      large === null
        ? fallbackPalette(sourceId)
        : paletteFromImage(large.rgba, large.width, large.height);
    const small = artwork === null ? null : coverRgba(artwork, 16);
    picture.current =
      small === null ? null : Picture.fromRgba(small.rgba, small.width, small.height);
    shown.current?.setPalette(colors.current);
    shown.current?.setPicture(picture.current);
  }, [props.artwork, sourceId]);

  useEffect(() => {
    if (!visual || !props.playing) return;
    renderer.requestLive();
    return () => renderer.dropLive();
  }, [visual, props.playing]);

  useEffect(() => {
    sincePreset.current = 0;
    if (index >= 0) shown.current?.select(index);
  }, [index]);

  useEffect(() => {
    const { x, y, width: columns, height: rows } = size;
    const box = host.current;
    if (!visual || box === null || columns <= 0 || rows <= 0) return;

    const width = mode === "halfBlocks" ? columns : columns * cellPixels.x;
    const height = mode === "halfBlocks" ? rows * 2 : rows * cellPixels.y;
    const visualizer = new Visualizer(width, height, presetList, Effect.runSync(Random.nextInt));
    visualizer.autoAdvance = 0;
    visualizer.setPalette(colors.current);
    visualizer.setPicture(picture.current);
    visualizer.select(indexRef.current);
    shown.current = visualizer;

    const kitty = graphics ? new KittyImage(visualId, columns, rows, backdropZ) : null;
    const surface = graphics
      ? null
      : new FrameBufferRenderable(renderer, { width: columns, height: rows });
    if (surface !== null) box.add(surface);
    const grid = new CellGrid(columns, rows);
    const cells = screenCells({ x, y, columns, rows }, theme, base);
    const output = new Uint8Array(width * height * 4);
    const feed = new AudioFeed();
    const analyzer = new Analyzer();
    const silence = new SampleRing(1);
    let sinceFrame = frameMs;
    let rendered = false;

    // Paused, it renders once and then only when a cell changes
    const draw = (buffer: OptimizedBuffer, deltaMs: number) => {
      const { playing, tap, positionMs } = latest.current;
      sinceFrame += deltaMs;
      const due = !rendered || (playing && sinceFrame >= frameMs - 2);
      // The video renders at 60 frames a second, but the backdrop needs only every second frame
      if (playing && !due) return;
      const changed = kitty !== null && cells.read(buffer);
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
        if (playing && latest.current.style === "visualizer") sincePreset.current += dt;
        if (sincePreset.current > presetSeconds) {
          sincePreset.current = 0;
          latest.current.onPresetEnd();
        }
        visualizer.render(audio, dt);
      }

      const rgba = visualizer.rgba;
      // The surface shows the cells with the next render
      if (surface !== null) {
        (mode === "octants" ? encodeOctants : encodeHalfBlocks)(rgba, width, height, grid);
        copyCells(grid, surface);
      }
      if (kitty === null) return;
      const [veilR = 0, veilG = 0, veilB = 0] = cells.veilColor;
      const veilAlpha = cells.veilAlpha;
      for (let py = 0; py < height; py++) {
        const row = Math.floor(py / cellPixels.y);
        for (let px = 0; px < width; px++) {
          const o = (py * width + px) * 4;
          if (cells.kinds[row * columns + Math.floor(px / cellPixels.x)] === 2) {
            output[o + 3] = 0;
            continue;
          }
          const value = cells.pixel(px, py);
          const keep = cells.veil ? value * (1 - veilAlpha) : value;
          const tint = cells.veil ? veilAlpha : 0;
          output[o] = (rgba[o] ?? 0) * keep + veilR * tint;
          output[o + 1] = (rgba[o + 1] ?? 0) * keep + veilG * tint;
          output[o + 2] = (rgba[o + 2] ?? 0) * keep + veilB * tint;
          output[o + 3] = 255;
        }
      }
      writeAt(
        x,
        y,
        files === true
          ? kitty.encodeFile(output, width, height)
          : kitty.encode(output, width, height, true),
      );
    };
    renderer.addPostProcessFn(draw);
    renderer.requestRender();

    return () => {
      renderer.removePostProcessFn(draw);
      if (kitty !== null) {
        process.stdout.write(kitty.delete());
        kitty.removeFiles();
      }
      if (surface !== null) {
        box.remove(surface);
        surface.destroy();
      }
      feed.close();
      shown.current = null;
    };
  }, [visual, size, graphics, files, base, theme.background, theme.backdrop]);

  // The video has more pixels than a backdrop can shade in time, so an image over it shades it.
  // Its partly transparent pixels are lighter in a terminal that blends in linear light.
  const shadesVideo = graphics && video;
  useEffect(() => {
    const { x, y, width: columns, height: rows } = size;
    if (!shadesVideo || columns <= 0 || rows <= 0) return;

    const width = columns * cellPixels.x;
    const height = rows * cellPixels.y;
    const kitty = new KittyImage(shadeId, columns, rows, shadeZ);
    const cells = screenCells({ x, y, columns, rows }, theme, base);
    const output = new Uint8Array(width * height * 4);
    let sent = false;

    // A cell with a background of its own gets it back; elsewhere the result is
    // `video * keep + veil color * veil alpha`
    const draw = (buffer: OptimizedBuffer) => {
      if (!cells.read(buffer) && sent) return;
      sent = true;
      const [veilR = 0, veilG = 0, veilB = 0] = cells.veilColor;
      for (let py = 0; py < height; py++) {
        const row = Math.floor(py / cellPixels.y);
        for (let px = 0; px < width; px++) {
          const o = (py * width + px) * 4;
          const at = row * columns + Math.floor(px / cellPixels.x);
          if (cells.kinds[at] === 2) {
            output[o] = cells.owns[at * 3] ?? 0;
            output[o + 1] = cells.owns[at * 3 + 1] ?? 0;
            output[o + 2] = cells.owns[at * 3 + 2] ?? 0;
            output[o + 3] = 255;
            continue;
          }
          const value = cells.pixel(px, py);
          const keep = cells.veil ? value * (1 - cells.veilAlpha) : value;
          const alpha = 1 - keep;
          const tint = cells.veil && alpha > 0 ? cells.veilAlpha / alpha : 0;
          output[o] = veilR * tint;
          output[o + 1] = veilG * tint;
          output[o + 2] = veilB * tint;
          output[o + 3] = alpha * 255;
        }
      }
      writeAt(
        x,
        y,
        files === true
          ? kitty.encodeFile(output, width, height)
          : kitty.encode(output, width, height, true),
      );
    };
    renderer.addPostProcessFn(draw);
    renderer.requestRender();

    return () => {
      renderer.removePostProcessFn(draw);
      process.stdout.write(kitty.delete());
      kitty.removeFiles();
    };
  }, [shadesVideo, size, files, base, theme.background, theme.backdrop]);

  const source = props.source;
  return (
    <box
      flexGrow={1}
      onSizeChange={function () {
        setSize({ x: this.x, y: this.y, width: this.width, height: this.height });
      }}
    >
      <box ref={host} position="absolute" left={0} top={0} width={size.width} height={size.height}>
        {video && source !== undefined && props.connection !== null && (
          <VideoPicture
            sourceId={source.id}
            playing={props.playing}
            positionMs={props.positionMs}
            delayMs={props.delayMs}
            connection={props.connection}
            serverUrl={props.serverUrl}
            columns={size.width}
            rows={size.height}
            maxHeight={videoMaxHeight}
            visible
            z={backdropZ}
            onFailure={props.onVideoFailure}
          />
        )}
      </box>
      {props.children}
    </box>
  );
}
