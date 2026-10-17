import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Schema } from "effect";

import { user } from "./auth.ts";

// Replica-local: commands and player reports need one writer, so sessions do not replicate

export const playbackSession = sqliteTable("playback_session", {
  userId: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  // The encoded `QueueEntry` values of `@dyad/domain`
  entries: text("entries", { mode: "json" }).$type<Schema.Json>().notNull(),
  nextEntryId: integer("next_entry_id").notNull(),
  queueVersion: integer("queue_version").notNull(),
  revision: integer("revision").notNull(),
  // `state`, `entryId`, `positionMs`, `outputId`, `shuffle` and `repeat`
  playback: text("playback", { mode: "json" }).$type<Schema.Json>().notNull(),
  updatedAt: integer("updated_at").notNull(),
});
