import { PlayContext, SourceSummary } from "@dyad/domain";
import { Schema } from "effect";

import { PlayQueue, RepeatMode, queueEntry } from "./queue.ts";

class SavedEntry extends Schema.Class<SavedEntry>("SavedEntry")({
  source: SourceSummary,
  context: PlayContext,
}) {}

/** The player state that a client restores on the next start, for one server */
export class SavedSession extends Schema.Class<SavedSession>("SavedSession")({
  entries: Schema.Array(SavedEntry),
  current: Schema.NullOr(Schema.Int),
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
}) {}

export const sessionOf = (queue: PlayQueue, volume: number) =>
  new SavedSession({
    entries: queue.entries.map(
      (entry) => new SavedEntry({ source: entry.source, context: entry.context }),
    ),
    current: queue.current,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    volume,
  });

export const queueOf = (session: SavedSession) =>
  new PlayQueue({
    entries: session.entries.map((entry) => queueEntry(entry.source, entry.context)),
    current: session.current,
    shuffle: session.shuffle,
    repeat: session.repeat,
  });
