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

/**
 * Replica-local MusicBrainz artist searches by `artistNameKey`. The count of artists with a key
 * tells whether a name is ambiguous.
 */
export const artistLookup = sqliteTable("artist_lookup", {
  nameKey: text("name_key").primaryKey(),
  // The MusicBrainz artists whose name or alias has the key
  artists: text("artists", { mode: "json" })
    .$type<
      ReadonlyArray<{
        readonly mbid: string;
        readonly name: string;
        readonly disambiguation: string | null;
        readonly country: string | null;
      }>
    >()
    .notNull(),
  checkedAt: integer("checked_at").notNull(),
});
