import type {
  EntryId,
  Playback,
  QueueEntry,
  QueueSplice,
  RepeatMode,
  SourceSegment,
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

/** The index of the segment of a DJ set that plays at `positionMs`, or -1 */
export const segmentIndexAt = (segments: ReadonlyArray<SourceSegment>, positionMs: number) =>
  segments.findLastIndex(
    (segment) =>
      segment.startMs !== null &&
      segment.startMs <= positionMs &&
      (segment.endMs === null || positionMs < segment.endMs),
  );

// Like most players, previous first goes back to the start of the current track
const restartAfterMs = 3000;

/**
 * Where next and previous seek inside the source: the next segment of a DJ set, or back to the
 * start of the current segment or source and then to the segment before. `undefined` when they skip
 * to the next or previous queue entry.
 */
export const skipSeekTarget = (
  segments: ReadonlyArray<SourceSegment>,
  positionMs: number,
  direction: 1 | -1,
) => {
  const starts = segments.flatMap((segment) => segment.startMs ?? []).toSorted((a, b) => a - b);
  if (direction === 1) return starts.find((start) => start > positionMs);

  const current = starts.findLast((start) => start <= positionMs);
  const target =
    current === undefined || positionMs - current > restartAfterMs
      ? current
      : starts.findLast((start) => start < current);
  return target ?? (positionMs > restartAfterMs ? 0 : undefined);
};
