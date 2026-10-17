import { index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Replica-local tables. Not replicated: paths and library roots belong to this replica.

export const libraryRoot = sqliteTable("library_root", {
  id: text("id").primaryKey(),
  // Imports go to this user's library. Null: the files are only in the catalog.
  ownerId: text("owner_id"),
  path: text("path").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});

export const localFile = sqliteTable(
  "local_file",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    libraryRootId: text("library_root_id")
      .notNull()
      .references(() => libraryRoot.id, { onDelete: "cascade" }),
    // Relative to the library root
    path: text("path").notNull(),
    size: integer("size").notNull(),
    mtime: integer("mtime").notNull(),
    // SHA-256 over the encoded audio packets, so that tag edits keep the same hash
    audioHash: text("audio_hash").notNull(),
    tags: text("tags", { mode: "json" }).notNull(),
    fingerprint: text("fingerprint"),
    loudnessLufs: real("loudness_lufs"),
    truePeak: real("true_peak"),
    trackGain: real("track_gain"),
    albumGain: real("album_gain"),
    scannedAt: integer("scanned_at").notNull(),
  },
  (table) => [
    uniqueIndex("local_file_path_idx").on(table.libraryRootId, table.path),
    index("local_file_source_idx").on(table.sourceId),
  ],
);
