// 480p decodes in WASM at about 15 % of one core; 720p costs twice that
const defaultHeight = 480;
const minHeight = 240;
const maxHeight = 720;

/** The `maxHeight` of `prepareVideo` for a picture of `pixelHeight`, or `null` when it is unknown */
export const videoMaxHeight = (pixelHeight: number | null) =>
  pixelHeight === null
    ? defaultHeight
    : Math.min(maxHeight, Math.max(minHeight, Math.round(pixelHeight)));

// Common heights of video streams. `prepareVideo` gives the tallest stream at most `maxHeight`.
const streamHeights = [minHeight, 360, defaultHeight, maxHeight];

/** The `maxHeight` of `prepareVideo` for the smallest stream at least `pixelHeight` high, at most 720p */
export const videoFillHeight = (pixelHeight: number) =>
  streamHeights.find((height) => height >= pixelHeight) ?? maxHeight;

/** The URL of a `VideoPlan` path that starts at the keyframe at or before `startMs` */
export const videoUrl = (serverUrl: string, path: string, startMs: number) => {
  const url = new URL(path, serverUrl);
  if (startMs > 0) url.searchParams.set("start", String(Math.floor(startMs)));
  return url;
};
