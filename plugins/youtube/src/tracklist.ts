import { TracklistEntry } from "@dyad/plugin";

const clock = /[[(]?(?<![\d:])((?:\d{1,2}:)?\d{1,2}:[0-5]\d)(?![\d:])[\])]?/g;
const separators = "\\s\\-–—|:•·";
// A list number such as `1.` or `2)` is not part of the artist
const leading = new RegExp(`^[${separators}]*(?:\\d{1,3}[.)]\\s+)?[${separators}]*`);
const trailing = new RegExp(`[${separators}]+$`);

/** Milliseconds of a clock time such as `1:02:03` or `12:34` */
export const clockMs = (text: string) =>
  text.split(":").reduce((total, part) => total * 60 + Number(part), 0) * 1000;

/** Splits `Artist - Title` */
export const tracklistEntry = (text: string, startMs: number | null) => {
  const line = text.replace(leading, "").replace(trailing, "");
  if (line === "") return undefined;

  const [, artist, title] = line.match(/^(.+?)\s[-–—]\s(.+)$/) ?? [];
  return artist === undefined || title === undefined
    ? new TracklistEntry({ startMs, artist: null, title: line })
    : new TracklistEntry({ startMs, artist: artist.trim(), title: title.trim() });
};

/**
 * The lines with a time, for example `12:34 Artist - Title`, `[1:02:03] Artist - Title` or
 * `1. Artist - Title (12:34)`. Other lines of a description are rarely tracks.
 */
export const parseTracklist = (text: string) =>
  text.split("\n").flatMap((line) => {
    const [time] = line.matchAll(clock);
    if (time?.[1] === undefined) return [];

    const entry = tracklistEntry(line.replaceAll(clock, " "), clockMs(time[1]));
    return entry === undefined ? [] : [entry];
  });
