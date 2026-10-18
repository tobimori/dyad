import { isSameSong } from "@dyad/domain";
import type { PlayContext, RepeatMode, SourceSummary } from "@dyad/domain";
import { Data, Effect, Random } from "effect";

export class QueueEntry extends Data.Class<{
  /** Tells apart two entries of the same source */
  readonly key: string;
  readonly source: SourceSummary;
  readonly context: typeof PlayContext.Type;
}> {}

// Keys only need to be unique in this process
let lastKey = 0;

export const queueEntry = (source: SourceSummary, context: typeof PlayContext.Type) => {
  lastKey += 1;
  return new QueueEntry({ key: String(lastKey), source, context });
};

/** Entries before `current` are the history that a skip back goes to */
export class PlayQueue extends Data.Class<{
  readonly entries: ReadonlyArray<QueueEntry>;
  /** `null` before the first play */
  readonly current: number | null;
  readonly shuffle: boolean;
  readonly repeat: typeof RepeatMode.Type;
}> {}

export const emptyQueue = new PlayQueue({
  entries: [],
  current: null,
  shuffle: false,
  repeat: "off",
});

export const currentEntry = (queue: PlayQueue) =>
  queue.current === null ? undefined : queue.entries[queue.current];

const shuffled = <A>(items: ReadonlyArray<A>) => Effect.runSync(Random.shuffle(items));

/**
 * Plays `sources[index]` and queues the rest of the list after it. A search lists one song once per
 * source, so a source that repeats the song before it does not go into the queue.
 */
export const playList = (
  queue: PlayQueue,
  sources: ReadonlyArray<SourceSummary>,
  index: number,
  context: typeof PlayContext.Type,
) => {
  const keep = (source: SourceSummary, position: number) => {
    if (position === index) return true;
    const before = sources[position - 1];
    return before === undefined || !isSameSong(before, source);
  };
  const kept = sources.filter(keep);
  const current = sources.slice(0, index).filter(keep).length;

  const entries = kept.map((source) => queueEntry(source, context));
  if (!queue.shuffle) return new PlayQueue({ ...queue, entries, current });

  // With shuffle, the whole list plays in random order, not only the part after `index`
  const first = entries.slice(current, current + 1);
  const others = entries.filter((_, position) => position !== current);
  return new PlayQueue({ ...queue, entries: [...first, ...shuffled(others)], current: 0 });
};

export const jumpTo = (queue: PlayQueue, index: number) =>
  new PlayQueue({ ...queue, current: index });

export const playNext = (queue: PlayQueue, entry: QueueEntry) => {
  const index = queue.current === null ? 0 : queue.current + 1;
  const entries = [...queue.entries.slice(0, index), entry, ...queue.entries.slice(index)];
  return new PlayQueue({ ...queue, entries });
};

export const addToQueue = (queue: PlayQueue, entries: ReadonlyArray<QueueEntry>) =>
  new PlayQueue({ ...queue, entries: [...queue.entries, ...entries] });

/** When `index` is the current entry, the entry after it becomes current */
export const removeEntry = (queue: PlayQueue, index: number) => {
  const entries = queue.entries.filter((_, position) => position !== index);
  if (queue.current === null || index > queue.current) return new PlayQueue({ ...queue, entries });
  if (index < queue.current)
    return new PlayQueue({ ...queue, entries, current: queue.current - 1 });

  const current = queue.current < entries.length ? queue.current : null;
  return new PlayQueue({ ...queue, entries, current });
};

/** Keeps only the current entry */
export const clearQueue = (queue: PlayQueue) => {
  const entry = currentEntry(queue);
  if (entry === undefined) return new PlayQueue({ ...queue, entries: [], current: null });
  return new PlayQueue({ ...queue, entries: [entry], current: 0 });
};

/** The queue after a skip or after the current entry ends, `undefined` when nothing comes next */
export const step = (queue: PlayQueue, direction: 1 | -1, reason: "skip" | "end") => {
  if (queue.current === null) return queue.entries.length === 0 ? undefined : jumpTo(queue, 0);
  if (reason === "end" && queue.repeat === "one") return queue;

  const index = queue.current + direction;
  if (index >= 0 && index < queue.entries.length) return jumpTo(queue, index);
  if (queue.repeat === "off") return undefined;

  return jumpTo(queue, direction === 1 ? 0 : queue.entries.length - 1);
};

/** Shuffles the entries after the current one. Turning shuffle off keeps the order. */
export const toggleShuffle = (queue: PlayQueue) => {
  if (queue.shuffle) return new PlayQueue({ ...queue, shuffle: false });

  const upcoming = queue.current === null ? 0 : queue.current + 1;
  const entries = [...queue.entries.slice(0, upcoming), ...shuffled(queue.entries.slice(upcoming))];
  return new PlayQueue({ ...queue, entries, shuffle: true });
};

const nextRepeatMode = { off: "all", all: "one", one: "off" } as const;

export const cycleRepeat = (queue: PlayQueue) =>
  new PlayQueue({ ...queue, repeat: nextRepeatMode[queue.repeat] });
