import type {
  EntryId,
  Playback,
  QueueEntry,
  QueueSplice,
  RepeatMode,
  SourceSummary,
} from "./index.ts";

export const applySplices = (
  entries: ReadonlyArray<QueueEntry>,
  splices: ReadonlyArray<QueueSplice>,
) => {
  const result = [...entries];
  for (const splice of splices) result.splice(splice.index, splice.remove, ...splice.insert);
  return result;
};

/**
 * The entry that plays after `entryId` ends or after a skip, without unplayable entries.
 * `undefined` when nothing comes next. A skip ignores `repeat: "one"`.
 */
export const nextEntry = (
  entries: ReadonlyArray<QueueEntry>,
  entryId: EntryId | null,
  repeat: typeof RepeatMode.Type,
  reason: "skip" | "end",
  direction: 1 | -1 = 1,
) => {
  const index = entries.findIndex((entry) => entry.id === entryId);
  if (index === -1) return entries.find((entry) => !entry.unplayable);
  if (reason === "end" && repeat === "one") return entries[index];

  // All other entries in play order, then the current entry
  const ring = [...entries.slice(index + 1), ...entries.slice(0, index + 1)];
  const ordered = direction === 1 ? ring : [...ring.slice(0, -1).toReversed(), ...ring.slice(-1)];
  const ahead = direction === 1 ? entries.length - index - 1 : index;
  return ordered
    .slice(0, repeat === "off" ? ahead : ordered.length)
    .find((entry) => !entry.unplayable);
};

/** The position at `now` in server time */
export const positionAt = (playback: Playback, now: number) =>
  playback.positionMs + (now - playback.at) * playback.rate;

const sameText = (left: string | null, right: string | null) =>
  left !== null && right !== null && left.toLowerCase() === right.toLowerCase();

const durationToleranceMs = 2000;

/** Two sources that look like one song, for example on an album and on a single */
export const isSameSong = (left: SourceSummary, right: SourceSummary) => {
  if (left.id === right.id) return true;
  if (!sameText(left.title, right.title) || !sameText(left.artist, right.artist)) return false;
  if (left.durationMs === null || right.durationMs === null) return true;
  return Math.abs(left.durationMs - right.durationMs) <= durationToleranceMs;
};
