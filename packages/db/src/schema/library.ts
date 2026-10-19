import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";

// The HLC of each field that a later write changed. A field without a key has the row `hlc`.
const fieldHlc = () => text("field_hlc", { mode: "json" }).$type<Record<string, string>>();

/**
 * Owner data for replication: deterministic IDs, an HLC, tombstones and no foreign keys. The
 * library is the rows that are not deleted, of any origin.
 */
export const libraryItem = sqliteTable(
  "library_item",
  {
    // UUIDv5 of `library_item:<entity_type>:<entity_id>:<origin>`. Rows from before single user
    // keep their old ID, so writers reuse the ID of an existing row.
    id: text("id").primaryKey(),
    entityType: text("entity_type", { enum: ["recording", "album", "artist"] }).notNull(),
    // The bound recording, album or artist of what the user marked, not its merge root. Views
    // resolve the root, so that merges and splits follow what the user marked.
    entityId: text("entity_id").notNull(),
    // `user` for a save in Dyad, `account:<provider>` for an import from the user's linked account
    origin: text("origin").notNull(),
    // `favorite` includes saved. A `removed` user row keeps an import from adding the entity again.
    mark: text("mark", { enum: ["saved", "favorite", "disliked", "removed"] })
      .notNull()
      .default("saved"),
    // When this replica first saw the item. Apple Music does not give the time that the user saved it.
    addedAt: integer("added_at").notNull(),
    hlc: text("hlc").notNull(),
    deleted: integer("deleted", { mode: "boolean" }).notNull(),
    changeSeq,
  },
  (table) => [
    index("library_item_origin_idx").on(table.origin, table.deleted),
    index("library_item_entity_idx").on(table.entityId),
    index("library_item_seq_idx").on(table.changeSeq),
  ],
);

export const playlist = sqliteTable(
  "playlist",
  {
    // UUIDv5 of `playlist:<provider>:<remote_id>` for an imported playlist
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    // `account:<provider>` for a playlist that the import added
    origin: text("origin"),
    // The provider playlist that the server syncs with this playlist, if any
    link: text("link", { mode: "json" }).$type<{
      readonly provider: string;
      readonly remoteId: string | null;
      readonly direction: "import" | "two-way";
    }>(),
    linkState: text("link_state", { mode: "json" }).$type<{
      readonly differs: boolean;
      readonly error: string | null;
    }>(),
    createdAt: integer("created_at").notNull(),
    hlc: text("hlc").notNull(),
    fieldHlc: fieldHlc(),
    deleted: integer("deleted", { mode: "boolean" }).notNull(),
    changeSeq,
  },
  (table) => [index("playlist_seq_idx").on(table.changeSeq)],
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
    index("playlist_entry_seq_idx").on(table.changeSeq),
  ],
);

/**
 * How the owner orders the sources of a recording. LWW per row: each write sets all fields. Only
 * the `global` scope exists now.
 */
export const sourcePreference = sqliteTable(
  "source_preference",
  {
    // UUIDv5 of `source_preference:<scope>`
    id: text("id").primaryKey(),
    scope: text("scope", { enum: ["global"] }).notNull(),
    // Provider IDs, best first, with `local` for files. Providers that it leaves out come after.
    providerRanking: text("provider_ranking", { mode: "json" })
      .$type<ReadonlyArray<string>>()
      .notNull(),
    hlc: text("hlc").notNull(),
    changeSeq,
  },
  (table) => [index("source_preference_seq_idx").on(table.changeSeq)],
);

/** The owner loves an entity. LWW per row: each write sets all fields. */
