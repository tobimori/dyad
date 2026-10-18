import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
    // `norm_v1` keys from the tags for the library views. Binding will replace them with the
    // `local_key` of catalog artists and release groups.
    albumArtistKey: text("album_artist_key"),
    artistKey: text("artist_key"),
    albumKey: text("album_key"),
    fingerprint: text("fingerprint"),
    scannedAt: integer("scanned_at").notNull(),
  },
  (table) => [
    uniqueIndex("local_file_path_idx").on(table.libraryRootId, table.path),
    index("local_file_source_idx").on(table.sourceId),
    index("local_file_album_idx").on(table.albumArtistKey, table.albumKey),
    index("local_file_artist_idx").on(table.artistKey),
  ],
);
