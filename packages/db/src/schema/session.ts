import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Schema } from "effect";

// Replica-local: commands and player reports need one writer, so rooms do not replicate
export const playbackSession = sqliteTable("playback_session", {
  // The output ID of the room's own output
  room: text("room").primaryKey(),
  // The last known name of the output, for a room whose output is offline
  name: text("name").notNull(),
  // The encoded `QueueEntry` values of `@dyad/domain`
  entries: text("entries", { mode: "json" }).$type<Schema.Json>().notNull(),
  nextEntryId: integer("next_entry_id").notNull(),
  queueVersion: integer("queue_version").notNull(),
  revision: integer("revision").notNull(),
  // `state`, `entryId`, `positionMs`, `outputId`, `group`, `shuffle` and `repeat`
  playback: text("playback", { mode: "json" }).$type<Schema.Json>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// Replica-local: a speaker is in the household of this replica
export const outputSetting = sqliteTable("output_setting", {
  outputId: text("output_id").primaryKey(),
  delayMs: integer("delay_ms").notNull(),
});
