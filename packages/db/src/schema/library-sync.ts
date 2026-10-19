import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";

/**
 * Replica-local, like the credentials that the import needs. No foreign key to `provider_account`:
 * a new link replaces that row, and the state stays.
 */
export const librarySyncState = sqliteTable("library_sync_state", {
  provider: text("provider").primaryKey(),
  // Probe value of the last complete songs read
  songsVersion: text("songs_version"),
  lastCompleteAt: integer("last_complete_at"),
  lastFullReadAt: integer("last_full_read_at"),
  lastAttemptAt: integer("last_attempt_at"),
  status: text("status", { enum: ["ok", "needs_relink", "throttled", "error"] }),
  // Safe to show, like `error`
  incompleteReason: text("incomplete_reason"),
  error: text("error"),
  // Throttled runs in a row. Sets the wait before the next run.
  throttleCount: integer("throttle_count").notNull().default(0),
  // The owner's song marks up to this `change_seq` went to the account. Starts at the link.
  marksSeq: integer("marks_seq"),
});

/**
 * The remote ID for later writes, and the fields to show while the song has no source. Replicated,
 * so that every replica shows the song.
 */
export const libraryRemoteTrack = sqliteTable(
  "library_remote_track",
  {
    // `<provider>:<recording_id>`
    id: text("id").notNull(),
    provider: text("provider").notNull(),
    recordingId: text("recording_id").notNull(),
    remoteId: text("remote_id").notNull(),
    catalogId: text("catalog_id"),
    sourceId: text("source_id"),
    rawTitle: text("raw_title").notNull(),
    rawArtist: text("raw_artist"),
    rawAlbum: text("raw_album"),
    rawDurationMs: integer("raw_duration_ms"),
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    hlc: text("hlc").notNull(),
    changeSeq,
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.recordingId] }),
    uniqueIndex("library_remote_track_id_idx").on(table.id),
    index("library_remote_track_seq_idx").on(table.changeSeq),
  ],
);

export const libraryRemotePlaylist = sqliteTable(
  "library_remote_playlist",
  {
    provider: text("provider").notNull(),
    remoteId: text("remote_id").notNull(),
    playlistId: text("playlist_id").notNull(),
    // The provider's version at the last complete read of the songs
    version: text("version"),
    // The bound recordings and the name that the provider had at the last sync. A sync applies only
    // the provider's changes since then, so that the edits in Dyad stay.
    snapshot: text("snapshot", { mode: "json" }).$type<ReadonlyArray<string>>(),
    name: text("name"),
    lastCompleteAt: integer("last_complete_at"),
    incompleteReason: text("incomplete_reason"),
  },
  (table) => [primaryKey({ columns: [table.provider, table.remoteId] })],
);
