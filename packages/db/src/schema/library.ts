import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";

// The HLC of each field that a later write changed. A field without a key has the row `hlc`.
const fieldHlc = () => text("field_hlc", { mode: "json" }).$type<Record<string, string>>();

/**
 * User data for later replication: deterministic IDs, an HLC, tombstones and no foreign keys. The
 * user's library is the rows that are not deleted, of any origin.
 */
export const libraryItem = sqliteTable(
  "library_item",
  {
    // UUIDv5 of `library_item:<user_id>:<entity_type>:<entity_id>:<origin>`
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    entityType: text("entity_type", { enum: ["recording"] }).notNull(),
    // The bound recording of what the user saved, not the canonical recording. Views resolve
    // `coalesce(merged_into_id, entity_id)`, so that merges and splits follow what the user saved.
    entityId: text("entity_id").notNull(),
    // `account:<provider>` for an import from the user's linked account
    origin: text("origin").notNull(),
    // When this replica first saw the item. Apple Music does not give the time that the user saved it.
    addedAt: integer("added_at").notNull(),
    hlc: text("hlc").notNull(),
    deleted: integer("deleted", { mode: "boolean" }).notNull(),
    changeSeq,
  },
  (table) => [
    index("library_item_user_idx").on(table.userId, table.deleted),
    index("library_item_entity_idx").on(table.entityId),
    index("library_item_change_idx").on(table.userId, table.changeSeq),
  ],
);

export const playlist = sqliteTable(
  "playlist",
  {
    // UUIDv5 of `playlist:<owner_id>:<provider>:<remote_id>` for an imported playlist
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    name: text("name").notNull(),
    // `account:<provider>` for a playlist that the import added
    origin: text("origin"),
    // The provider playlist that the server syncs with this playlist, if any
    link: text("link", { mode: "json" }).$type<{
      readonly provider: string;
      readonly remoteId: string | null;
      readonly direction: "import";
    }>(),
    createdAt: integer("created_at").notNull(),
    hlc: text("hlc").notNull(),
    fieldHlc: fieldHlc(),
    deleted: integer("deleted", { mode: "boolean" }).notNull(),
    changeSeq,
  },
  (table) => [index("playlist_owner_idx").on(table.ownerId, table.deleted)],
);

export const playlistEntry = sqliteTable(
  "playlist_entry",
  {
    // UUIDv5 of `playlist_entry:<playlist_id>:<recording_id>:<n>` for an imported entry, where `n`
    // counts the earlier entries of the same recording from 1. A reorder changes only `position`.
    id: text("id").primaryKey(),
    playlistId: text("playlist_id").notNull(),
    // The bound recording, as in `library_item`
    recordingId: text("recording_id").notNull(),
    position: text("position").notNull(),
    addedAt: integer("added_at").notNull(),
    hlc: text("hlc").notNull(),
    fieldHlc: fieldHlc(),
    deleted: integer("deleted", { mode: "boolean" }).notNull(),
    changeSeq,
  },
  (table) => [
    index("playlist_entry_playlist_idx").on(table.playlistId, table.deleted),
    index("playlist_entry_change_idx").on(table.playlistId, table.changeSeq),
  ],
);
