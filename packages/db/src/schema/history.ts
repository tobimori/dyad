import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";

/**
 * One play of a source. Append-only owner data. Rows have UUIDv7 IDs
 * and do not change, so that replicas can merge them by union. `scrobbled` is the only exception;
 * it changes only from false to true.
 */
export const playEvent = sqliteTable(
  "play_event",
  {
    // UUIDv7
    id: text("id").primaryKey(),
    // No foreign keys: rows from other replicas can refer to devices and sources that this
    // replica does not have
    deviceId: text("device_id").notNull(),
    sourceId: text("source_id").notNull(),
    // Null until sources are matched to recordings
    recordingId: text("recording_id"),
    startedAt: integer("started_at").notNull(),
    playedMs: integer("played_ms").notNull(),
    completed: integer("completed", { mode: "boolean" }).notNull(),
    // A `PlayContext` of `@dyad/domain`
    context: text("context").notNull(),
    scrobbled: integer("scrobbled", { mode: "boolean" }).notNull().default(false),
    changeSeq,
  },
  (table) => [
    // Search ranking reads the recent plays
    index("play_event_started_idx").on(table.startedAt),
    index("play_event_seq_idx").on(table.changeSeq),
  ],
);
