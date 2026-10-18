import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Replica-local, like the credentials that the import needs. No foreign key to `provider_account`:
 * a new link replaces that row, and the state stays.
 */
export const librarySyncState = sqliteTable(
  "library_sync_state",
  {
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
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
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider] })],
);

/** The remote ID for later writes, and the fields to show while the song has no source */
export const libraryRemoteTrack = sqliteTable(
  "library_remote_track",
  {
    userId: text("user_id").notNull(),
    provider: text("provider").notNull(),
    recordingId: text("recording_id").notNull(),
    remoteId: text("remote_id").notNull(),
    catalogId: text("catalog_id"),
    sourceId: text("source_id"),
    rawTitle: text("raw_title").notNull(),
    rawArtist: text("raw_artist"),
    rawAlbum: text("raw_album"),
    rawDurationMs: integer("raw_duration_ms"),
    // The time of the last read of the library songs that had it. 0: only playlist reads had it.
    seenAt: integer("seen_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.provider, table.recordingId] })],
);

export const libraryRemotePlaylist = sqliteTable(
  "library_remote_playlist",
  {
    userId: text("user_id").notNull(),
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
  (table) => [primaryKey({ columns: [table.userId, table.provider, table.remoteId] })],
);
