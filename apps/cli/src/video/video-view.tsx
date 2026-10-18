import { videoFillHeight } from "@dyad/client-runtime";
import type { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import { CellGrid, encodeHalfBlocks, encodeOctants, graphicsSupport } from "@dyad/visualizer";
import { KittyImage } from "@dyad/visualizer/kitty";
import { FrameBufferRenderable, RGBA } from "@opentui/core";
import type { BoxRenderable } from "@opentui/core";
import { useRenderer } from "@opentui/react";
import { Effect, Fiber } from "effect";
import { useEffect, useRef, useState } from "react";

import { Cover } from "../component/cover.tsx";
import type { Artwork } from "../component/use-artwork.ts";
import { useSettings } from "../context/settings.ts";
import { VideoStream } from "./video-stream.ts";

const mode = graphicsSupport(process.env);
// Two IDs, so that the image of a cover and of a backdrop can exist while one replaces the other
const imageId = 0x5d1a7f;
const underImageId = 0x5d1a7e;
// Ghostty 1.3.1 takes compressed escape data at only about 30 MB/s
const zlibMaxWidth = 480;
// A position change by more than this beyond the played time is a seek
const seekThresholdMs = 1000;
const probeTimeoutMs = 500;

// Without `t=t`, for example over SSH, frames go as compressed escape data
let fileFrames: boolean | undefined;

/** Draws the cells of `grid` into `target` */
export const copyCells = (grid: CellGrid, target: FrameBufferRenderable) => {
  target.frameBuffer.withBuffers((cells) => {
    const count = Math.min(cells.char.length, grid.chars.length);
    for (let cell = 0; cell < count; cell++) {
      cells.char[cell] = grid.chars[cell] ?? 0x20;
      for (let channel = 0; channel < 3; channel++) {
        cells.fg[cell * 4 + channel] = grid.foreground[cell * 3 + channel] ?? 0;
        cells.bg[cell * 4 + channel] = grid.background[cell * 3 + channel] ?? 0;
      }
      cells.fg[cell * 4 + 3] = 255;
      cells.bg[cell * 4 + 3] = 255;
    }
  });
  target.requestRender();
};

/** `true` when the terminal reads Kitty frames from temporary files, `undefined` until it answers */
export function useKittyFiles() {
  const renderer = useRenderer();
  const [files, setFiles] = useState(fileFrames);

  // The terminal answers only on the same host
  useEffect(() => {
    if (mode !== "kitty" || files !== undefined) return;
    const probe = new KittyImage(imageId, 1, 1);
    const finish = (answer: boolean) => {
      renderer.removeInputHandler(handler);
      probe.removeFiles();
      fileFrames = answer;
      setFiles(answer);
    };
    const handler = (sequence: string) => {
      const answer = probe.fileAnswer(sequence);
      if (answer === undefined) return false;
      Effect.runFork(Fiber.interrupt(timeout));
      finish(answer);
      return true;
    };
    const timeout = Effect.runFork(
      Effect.sleep(probeTimeoutMs).pipe(Effect.andThen(Effect.sync(() => finish(false)))),
    );
    renderer.prependInputHandler(handler);
    process.stdout.write(probe.fileQuery());
    return () => {
      renderer.removeInputHandler(handler);
      Effect.runFork(Fiber.interrupt(timeout));
    };
  }, []);

  return files;
}

/** The video of a source, timed by its audio, in the largest box of its aspect in the cells */
export function VideoPicture(props: {
  readonly sourceId: string;
  readonly playing: boolean;
  readonly positionMs: () => number;
  /** Shows the video this much later than `positionMs` */
  readonly delayMs: number;
  readonly connection: typeof ServerConnection.Service;
  readonly serverUrl: string;
  readonly columns: number;
  readonly rows: number;
  /** The `maxHeight` of `prepareVideo` for a picture of `pixelHeight` */
  readonly maxHeight: (pixelHeight: number) => number;
  readonly visible: boolean;
  /** With Kitty graphics, the video shows under the text at this z-index, not through placeholders */
  readonly z?: number;
  readonly onFrame?: () => void;
  readonly onFailure: (reason: string) => void;
}) {
  const renderer = useRenderer();
  const host = useRef<BoxRenderable | null>(null);
  const stream = useRef<VideoStream | null>(null);
  // The frame callback lives longer than one render, so it reads the newest values here
  const latest = useRef(props);
  latest.current = props;
  const [aspect, setAspect] = useState(16 / 9);
  const files = useKittyFiles();
  // A paused clock brings no frame, so the renders go on until the frame after a seek shows
  const [waiting, setWaiting] = useState(true);

  const resolution = renderer.resolution;
  const cellWidth = resolution === null ? 10 : resolution.width / renderer.terminalWidth;
  const cellHeight = resolution === null ? 20 : resolution.height / renderer.terminalHeight;
  // The terminal stretches the image to this box
  const boxColumns = Math.max(
    1,
    Math.min(props.columns, Math.floor((props.rows * cellHeight * aspect) / cellWidth)),
  );
  const boxRows = Math.max(
    1,
    Math.min(props.rows, Math.round((boxColumns * cellWidth) / aspect / cellHeight)),
  );
  const pixels = (() => {
    if (mode === "octants") return { width: boxColumns * 2, height: boxRows * 4 };
    if (mode === "halfBlocks") return { width: boxColumns, height: boxRows * 2 };
    const width = boxColumns * cellWidth;
    const height = boxRows * cellHeight;
    const scale = files === false ? Math.min(1, zlibMaxWidth / width) : 1;
    return { width: Math.round(width * scale), height: Math.round(height * scale) };
  })();
  const pixelsRef = useRef(pixels);
  pixelsRef.current = pixels;

  useEffect(() => {
    const request = Effect.runFork(
      props.connection
        .prepareVideo({
          sourceId: props.sourceId,
          maxHeight: latest.current.maxHeight(pixelsRef.current.height),
        })
        .pipe(
          Effect.tap((plan) =>
            Effect.sync(() => {
              stream.current = new VideoStream({
                serverUrl: latest.current.serverUrl,
                path: plan.path,
                startMs: Math.max(0, latest.current.positionMs() - latest.current.delayMs),
                ...pixelsRef.current,
                onSize: (width, height) => setAspect(width / height),
                onFailure: (reason) => latest.current.onFailure(reason),
              });
            }),
          ),
          Effect.catch(() =>
            Effect.sync(() => latest.current.onFailure("This track has no video")),
          ),
        ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(request));
      stream.current?.close();
      stream.current = null;
    };
  }, [props.sourceId]);

  useEffect(() => {
    stream.current?.resize(pixels.width, pixels.height);
  }, [pixels.width, pixels.height]);

  useEffect(() => {
    if (!props.playing && !waiting) return;
    renderer.requestLive();
    return () => renderer.dropLive();
  }, [props.playing, waiting]);

  useEffect(() => {
    const box = host.current;
    if (box === null || (mode === "kitty" && files === undefined)) return;

    setWaiting(true);
    const z = mode === "kitty" ? (props.z ?? null) : null;
    const surface =
      z === null
        ? new FrameBufferRenderable(renderer, { width: boxColumns, height: boxRows })
        : null;
    if (surface !== null) box.add(surface);
    const grid = new CellGrid(boxColumns, boxRows);
    const kitty =
      mode === "kitty"
        ? new KittyImage(z === null ? imageId : underImageId, boxColumns, boxRows, z)
        : null;
    // Yoga centers the placeholder surface; an image under the text goes to the same cells
    const moveTo = () => {
      const row = box.y + Math.floor((latest.current.rows - boxRows) / 2);
      const column = box.x + Math.floor((latest.current.columns - boxColumns) / 2);
      return `\x1b7\x1b[${row + 1};${column + 1}H`;
    };
    if (kitty !== null && surface !== null) {
      const { r, g, b } = kitty.foreground;
      const black = RGBA.fromInts(0, 0, 0, 255);
      for (const [row, text] of kitty.placeholderRows.entries()) {
        surface.frameBuffer.drawText(text, 0, row, RGBA.fromInts(r, g, b, 255), black);
      }
    }

    let lastMs = latest.current.positionMs();
    let lastAt = performance.now();
    let shown = false;
    const frame = () => {
      const video = stream.current;
      const at = performance.now();
      const positionMs = latest.current.positionMs();
      const jumpMs = positionMs - lastMs;
      const elapsedMs = latest.current.playing ? at - lastAt : 0;
      const seeked = jumpMs < -seekThresholdMs / 4 || jumpMs > elapsedMs + seekThresholdMs;
      lastMs = positionMs;
      lastAt = at;
      if (video === null) return Promise.resolve();

      const nowMs = positionMs - latest.current.delayMs;
      if (seeked) {
        video.seek(nowMs);
        setWaiting(true);
      }
      const due = video.take(nowMs);
      if (due !== undefined) {
        const rgba = new Uint8Array(due.rgba);
        // TTY writes are synchronous on Linux and macOS, so the file and the buffer are free after
        if (z !== null) process.stdout.write(moveTo());
        if (kitty !== null && files === true) {
          process.stdout.write(kitty.encodeFile(rgba, due.width, due.height));
        }
        if (kitty !== null && files === false) {
          process.stdout.write(kitty.encode(rgba, due.width, due.height));
        }
        if (z !== null) process.stdout.write("\x1b8");
        if (kitty === null && surface !== null) {
          (mode === "octants" ? encodeOctants : encodeHalfBlocks)(
            rgba,
            due.width,
            due.height,
            grid,
          );
          copyCells(grid, surface);
        }
        video.release(due);
        if (!shown) latest.current.onFrame?.();
        shown = true;
        setWaiting(false);
      }
      video.pull(nowMs);
      return Promise.resolve();
    };
    // Video frames come every 33 to 42 ms, so 30 renders a second would show some of them late
    const targetFps = renderer.targetFps;
    renderer.targetFps = 60;
    renderer.setFrameCallback(frame);

    return () => {
      renderer.removeFrameCallback(frame);
      renderer.targetFps = targetFps;
      if (kitty !== null) {
        process.stdout.write(kitty.delete());
        kitty.removeFiles();
      }
      if (surface !== null) {
        box.remove(surface);
        surface.destroy();
      }
    };
    // A new surface for each source, so that no frame of the last video stays
  }, [boxColumns, boxRows, files, props.sourceId]);

  return (
    <box
      ref={host}
      width={props.columns}
      height={props.rows}
      alignItems="center"
      justifyContent="center"
      visible={props.visible}
    />
  );
}

// Loads its own settings on each mount, so that a delay that the backdrop keys changed applies
function CoverVideo(props: {
  readonly source: SourceSummary;
  readonly artwork: Artwork | null;
  readonly video: boolean;
  readonly playing: boolean;
  readonly positionMs: () => number;
  readonly connection: typeof ServerConnection.Service | null;
  readonly serverUrl: string;
  readonly width: number;
  readonly height: number;
  readonly onFailure: () => void;
}) {
  const [settings] = useSettings();
  // A source ID, so that the next source starts with its cover
  const [shown, setShown] = useState<string | null>(null);
  const id = props.source.id;
  const showing = props.video && shown === id;

  return (
    <box width={props.width} height={props.height}>
      {!showing && <Cover artwork={props.artwork} width={props.width} height={props.height} />}
      {props.video && props.connection !== null && settings !== null && (
        <VideoPicture
          sourceId={id}
          playing={props.playing}
          positionMs={props.positionMs}
          delayMs={settings.videoDelayMs ?? 0}
          connection={props.connection}
          serverUrl={props.serverUrl}
          columns={props.width}
          rows={props.height}
          maxHeight={videoFillHeight}
          visible={showing}
          onFrame={() => setShown(id)}
          onFailure={props.onFailure}
        />
      )}
    </box>
  );
}

/**
 * Whether the cover of the source that plays shows its muted video, and `render` for the cover in
 * a box of cells. Cells are too coarse for a picture this small, so only Kitty graphics show video.
 */
export const useCoverVideo = (props: {
  readonly source: SourceSummary | undefined;
  /** `false` shows the cover also for a source with video */
  readonly video: boolean;
  readonly artwork: Artwork | null;
  readonly playing: boolean;
  readonly positionMs: () => number;
  readonly connection: typeof ServerConnection.Service | null;
  readonly serverUrl: string;
}) => {
  const [settings] = useSettings();
  // A source ID, so that the cover shows for the rest of a source whose video failed
  const [failed, setFailed] = useState<string | null>(null);
  const source = props.source;
  const video =
    props.video &&
    mode === "kitty" &&
    source?.video === true &&
    props.connection !== null &&
    settings !== null &&
    settings.coverVideo !== false &&
    failed !== source.id;

  const render = (width: number, height: number) =>
    source !== undefined && (
      <CoverVideo
        source={source}
        artwork={props.artwork}
        video={video}
        playing={props.playing}
        positionMs={props.positionMs}
        connection={props.connection}
        serverUrl={props.serverUrl}
        width={width}
        height={height}
        onFailure={() => setFailed(source.id)}
      />
    );
  return { video, render };
};
