import { formatDuration, titleOf } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import {
  Analyzer,
  CellGrid,
  SampleRing,
  Visualizer,
  defaultPalettes,
  encodeHalfBlocks,
  encodeOctants,
  graphicsSupport,
  paletteFromImage,
  presets,
} from "@dyad/visualizer";
import type { Rgb } from "@dyad/visualizer";
import { KittyImage } from "@dyad/visualizer/kitty";
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Effect, Random } from "effect";
import { useEffect, useRef, useState } from "react";

import type { Artwork } from "../component/use-artwork.ts";
import { commands, keyLabel, useCommands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { fit } from "../ui/format.ts";
import { AudioFeed } from "./audio-feed.ts";
import type { AudioTap } from "./audio-feed.ts";

const mode = graphicsSupport(process.env);
// About 320 by 180; more pixels cost more CPU and terminal bandwidth than they add
const kittyPixels = 320 * 180;
const imageId = 0x5d1a7e;
const presetSeconds = 40;
const labelSeconds = 3;

// Kitty scales the image to the cells, so its pixels must have the aspect of the cell area
const pixelSize = (columns: number, rows: number, cellAspect: number) => {
  if (mode === "octants") return [columns * 2, rows * 4] as const;
  if (mode === "halfBlocks") return [columns, rows * 2] as const;
  const aspect = columns / (rows * cellAspect);
  const width = Math.max(1, Math.round(Math.sqrt(kittyPixels * aspect)));
  return [width, Math.max(1, Math.round(width / aspect))] as const;
};

// Tracks without a cover still get their own colors
const fallbackPalette = (key: string) => {
  let hash = 0;
  for (const char of key) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return defaultPalettes[hash % defaultPalettes.length] ?? [];
};

const coverPalette = (artwork: Artwork) => {
  const small = artwork.image.resize({ width: 48, height: 48 });
  const raw = small.raw("rgba8");
  const rgba = new Uint8Array(raw.width * raw.height * 4);
  for (let y = 0; y < raw.height; y++) {
    rgba.set(raw.data.subarray(y * raw.stride, y * raw.stride + raw.width * 4), y * raw.width * 4);
  }
  small.dispose();
  return paletteFromImage(rgba, raw.width, raw.height);
};

const copyCells = (grid: CellGrid, target: FrameBufferRenderable) => {
  target.frameBuffer.withBuffers((cells) => {
    const chars = cells.char;
    const fg = cells.fg;
    const bg = cells.bg;
    const count = Math.min(chars.length, grid.chars.length);
    for (let cell = 0; cell < count; cell++) {
      chars[cell] = grid.chars[cell] ?? 0x20;
      for (let channel = 0; channel < 3; channel++) {
        fg[cell * 4 + channel] = grid.foreground[cell * 3 + channel] ?? 0;
        bg[cell * 4 + channel] = grid.background[cell * 3 + channel] ?? 0;
      }
      fg[cell * 4 + 3] = 255;
      bg[cell * 4 + 3] = 255;
    }
  });
  target.requestRender();
};

/** Full-screen visualizer of the audio that plays on this device, with one now-playing line */
export function VisualizerView(props: {
  readonly source: SourceSummary | undefined;
  readonly artwork: Artwork | null;
  readonly playing: boolean;
  readonly tap: () => AudioTap | null;
  readonly positionMs: () => number;
  readonly durationMs: number | null;
  readonly width: number;
  readonly height: number;
}) {
  const renderer = useRenderer();
  const theme = useTheme();
  const host = useRef<BoxRenderable | null>(null);
  // The frame callback lives longer than one render, so it reads the newest props here
  const latest = useRef(props);
  latest.current = props;

  const [state] = useState(() => ({
    feed: new AudioFeed(),
    analyzer: new Analyzer(),
    silence: new SampleRing(1),
    preset: Effect.runSync(Random.nextIntBetween(0, presets.length, { halfOpen: true })),
    sincePreset: 0,
    sinceLabel: 0,
  }));
  const shown = useRef<Visualizer | null>(null);
  const colors = useRef<ReadonlyArray<Rgb>>([]);
  const [label, setLabel] = useState(() => presets[state.preset]?.label ?? null);
  const [heard, setHeard] = useState(true);

  const selectPreset = (index: number) => {
    const count = presets.length;
    state.preset = ((index % count) + count) % count;
    state.sincePreset = 0;
    state.sinceLabel = 0;
    shown.current?.select(state.preset);
    setLabel(presets[state.preset]?.label ?? null);
  };

  useCommands([
    [commands.nextPreset, () => selectPreset(state.preset + 1)],
    [commands.previousPreset, () => selectPreset(state.preset - 1)],
  ]);

  useEffect(() => () => state.feed.close(), []);

  const sourceId = props.source?.id ?? "";
  useEffect(() => {
    colors.current =
      props.artwork === null ? fallbackPalette(sourceId) : coverPalette(props.artwork);
    shown.current?.setPalette(colors.current);
  }, [props.artwork, sourceId]);

  const columns = props.width;
  const rows = props.height - 1;

  useEffect(() => {
    const box = host.current;
    if (box === null || columns <= 0 || rows <= 0) return;

    const resolution = renderer.resolution;
    const cellAspect =
      resolution === null
        ? 2
        : resolution.height / renderer.terminalHeight / (resolution.width / renderer.terminalWidth);
    const [width, height] = pixelSize(columns, rows, cellAspect);
    const visualizer = new Visualizer(width, height, presets, Effect.runSync(Random.nextInt));
    visualizer.autoAdvance = 0;
    visualizer.setPalette(colors.current);
    visualizer.select(state.preset);
    shown.current = visualizer;

    const surface = new FrameBufferRenderable(renderer, { width: columns, height: rows });
    box.add(surface);
    const grid = new CellGrid(columns, rows);
    const kitty = mode === "kitty" ? new KittyImage(imageId, columns, rows) : null;
    if (kitty !== null) {
      const { r, g, b } = kitty.foreground;
      const black = RGBA.fromInts(0, 0, 0, 255);
      for (const [row, text] of kitty.placeholderRows.entries()) {
        surface.frameBuffer.drawText(text, 0, row, RGBA.fromInts(r, g, b, 255), black);
      }
    }

    const frame = (deltaMs: number) => {
      const dt = deltaMs / 1000;
      const { playing, tap, positionMs } = latest.current;
      const tapped = playing ? tap() : null;
      const audio =
        tapped === null
          ? state.analyzer.update(state.silence, 0, dt)
          : state.analyzer.update(state.feed.ring, state.feed.update(tapped, positionMs()), dt);
      setHeard(!playing || tapped !== null);

      state.sincePreset += dt;
      state.sinceLabel += dt;
      if (state.sincePreset > presetSeconds) selectPreset(state.preset + 1);
      if (state.sinceLabel > labelSeconds) setLabel(null);

      const rgba = visualizer.render(audio, dt);
      // TTY writes are synchronous on Linux and macOS, so the reused encode buffer is safe
      if (kitty !== null) process.stdout.write(kitty.encode(rgba, width, height));
      if (kitty === null) {
        (mode === "octants" ? encodeOctants : encodeHalfBlocks)(rgba, width, height, grid);
        copyCells(grid, surface);
      }
      return Promise.resolve();
    };
    renderer.setFrameCallback(frame);
    renderer.requestLive();

    return () => {
      renderer.removeFrameCallback(frame);
      renderer.dropLive();
      if (kitty !== null) process.stdout.write(kitty.delete());
      box.remove(surface);
      surface.destroy();
      shown.current = null;
    };
  }, [columns, rows]);

  const source = props.source;
  const time = `${formatDuration(props.positionMs())} / ${formatDuration(props.durationMs)}`;
  const key = (command: Command) => keyLabel(command.keys[0] ?? "");
  const hint = `${key(commands.previousPreset)} ${key(commands.nextPreset)} visual   ${key(commands.close)} close`;
  const status = label ?? (heard ? hint : "The audio plays on another device");
  const title =
    source === undefined
      ? "Nothing is playing"
      : `${titleOf(source)}${source.artist === null ? "" : `  ${source.artist}`}`;
  const titleWidth = Math.max(0, props.width - time.length - status.length - 8);

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor="#000000">
      <box ref={host} flexGrow={1} />
      <box flexDirection="row" height={1} paddingX={1} gap={2} backgroundColor={theme.panel}>
        <text flexGrow={1} wrapMode="none">
          <span fg={theme.accent}>{props.playing ? "▶ " : "⏸ "}</span>
          <span fg={theme.text}>{fit(title, titleWidth)}</span>
        </text>
        <text fg={label === null ? theme.faint : theme.accent} wrapMode="none" flexShrink={0}>
          {status}
        </text>
        <text fg={theme.muted} wrapMode="none" flexShrink={0}>
          {time}
        </text>
      </box>
    </box>
  );
}
