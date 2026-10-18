import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";

/**
 * One play of a source by a user. Append-only user data in the user scope. Rows have UUIDv7 IDs
 * and do not change, so that replicas can merge them by union. `scrobbled` is the only exception;
 * it changes only from false to true.
 */
export const playEvent = sqliteTable(
  "play_event",
  {
    // UUIDv7
    id: text("id").primaryKey(),
    // No foreign keys: rows from other replicas can refer to users, devices and sources that this
    // replica does not have
    userId: text("user_id").notNull(),
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
    // Search ranking reads the recent plays of one user
    index("play_event_user_started_idx").on(table.userId, table.startedAt),
    index("play_event_change_idx").on(table.userId, table.changeSeq),
  ],
);
