import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// The synced tables of a client replica have the same columns as on the server
export { recording } from "../schema/catalog.ts";
export { playEvent } from "../schema/history.ts";
export { libraryRemoteTrack } from "../schema/library-sync.ts";
export { libraryItem, playlist, playlistEntry } from "../schema/library.ts";
export { source, sourceVariant } from "../schema/source.ts";

/** Own mutations that the server has not acknowledged */
export const syncQueue = sqliteTable("sync_queue", {
  mutationId: integer("mutation_id").primaryKey(),
  // An encoded `SyncMutation` of `@dyad/domain`
  mutation: text("mutation", { mode: "json" }).notNull(),
});

/** A followed scope and the `ScopeCursor` of its rows */
export const syncScope = sqliteTable("sync_scope", {
  scope: text("scope").primaryKey(),
  changeSeq: integer("change_seq").notNull(),
  rowKey: text("row_key"),
  // Null until the first load of the scope has ended
  loadedAt: integer("loaded_at"),
});

/** The `local_file` keys of the server, for the page refs of local sources */
export const sourceKey = sqliteTable("source_key", {
  sourceId: text("source_id").primaryKey(),
  albumArtistKey: text("album_artist_key"),
  artistKey: text("artist_key"),
  albumKey: text("album_key"),
});

/** For example the replica ID, the epoch, the catalog cursor and the clock offset */
export const clientState = sqliteTable("client_state", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).notNull(),
});
