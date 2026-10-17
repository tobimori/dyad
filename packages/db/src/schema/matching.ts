import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

/**
 * Replica-local MusicBrainz ISRC results, so that matching decides again without a request.
 * Other replicas receive only the merges.
 */
export const isrcLookup = sqliteTable("isrc_lookup", {
  isrc: text("isrc").primaryKey(),
  // All MusicBrainz recordings that had the ISRC
  recordings: text("recordings", { mode: "json" })
    .$type<ReadonlyArray<{ readonly mbid: string; readonly durationMs: number | null }>>()
    .notNull(),
  checkedAt: integer("checked_at").notNull(),
});
