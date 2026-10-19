import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";
import { projection } from "./projection.ts";

// Canonical catalog tables are projections of `catalog_assertion` rows. Every server replica makes
// the same rows; clients receive them.
// There are no foreign key constraints: assertions arrive in any order, and clients hold only some
// related rows. Relations are declared in `relations.ts`.

export const entityOrigins = ["musicbrainz", "isrc", "provider", "local", "admin"] as const;

// Entities that can be merged, hidden and identified
const entity = {
  // Origin of the ID. UUIDv5 IDs are opaque, and the merge winner depends on it.
  origin: text("origin", { enum: entityOrigins }).notNull(),
  // Derived: `merged` from `entity_merge`, `hidden` from an admin assertion
  status: text("status", { enum: ["active", "merged", "hidden"] })
    .notNull()
    .default("active"),
  ...projection,
};

export const artist = sqliteTable(
  "artist",
  {
    id: text("id").primaryKey(),
    // Binding key for local artists: `norm(name)`. Resolved from `local_key` assertions.
    localKey: text("local_key"),
    name: text("name"),
    sortName: text("sort_name"),
    kind: text("kind", {
      enum: ["person", "group", "orchestra", "choir", "character", "other"],
    }),
    country: text("country"),
    disambiguation: text("disambiguation"),
    // `artistNameKey(name)`. Many artists share a key, so it only finds candidates for a link.
    nameKey: text("name_key"),
    // Root of the merge tree, like `recording.merged_into_id`
    mergedIntoId: text("merged_into_id"),
    ...entity,
  },
  (table) => [
    index("artist_local_key_idx").on(table.localKey),
    index("artist_name_key_idx").on(table.nameKey),
    index("artist_merged_into_idx").on(table.mergedIntoId),
  ],
);

const creditName = {
  position: integer("position").notNull(),
  // Null for a name that no evidence links to an artist
  artistId: text("artist_id"),
  name: text("name").notNull(),
  joinPhrase: text("join_phrase").notNull().default(""),
};

/** The credited names of a recording, from its resolved `artist_credit` */
export const songArtist = sqliteTable(
  "song_artist",
  { recordingId: text("recording_id").notNull(), ...creditName },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.position] }),
    index("song_artist_artist_idx").on(table.artistId),
  ],
);

/** The credited names of an album, from the credit of its original edition */
export const albumArtist = sqliteTable(
  "album_artist",
  { albumId: text("album_id").notNull(), ...creditName },
  (table) => [
    primaryKey({ columns: [table.albumId, table.position] }),
    index("album_artist_artist_idx").on(table.artistId),
  ],
);

export const recording = sqliteTable(
  "recording",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    durationMs: integer("duration_ms"),
    disambiguation: text("disambiguation"),
    // The credit as one text, for example `A feat. B`. Artist entities need corroborated identity.
    artistName: text("artist_name"),
    // The album of the song when an edition has it, else the `album` fact
    album: text("album"),
    albumId: text("album_id"),
    artworkUrl: text("artwork_url"),
    explicit: integer("explicit", { mode: "boolean" }),
    // Root of the merge tree, resolved from the effective `entity_merge` edges. Null for a root.
    mergedIntoId: text("merged_into_id"),
    ...entity,
  },
  (table) => [
    index("recording_merged_into_idx").on(table.mergedIntoId),
    index("recording_revision_idx").on(table.revision),
  ],
);

/**
 * A version or mashup part and its original, from `derivative_of`. A link is not a merge: audio
 * never moves. Views resolve `original_id` through `merged_into_id`.
 */
export const recordingDerivative = sqliteTable(
  "recording_derivative",
  {
    recordingId: text("recording_id").notNull(),
    originalId: text("original_id").notNull(),
    // Index of the mashup part, null for a version of one recording
    part: integer("part"),
    // The first version that the recording adds over `original_id`, for example `remix`
    kind: text("kind").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.recordingId, table.originalId] }),
    index("recording_derivative_original_idx").on(table.originalId),
  ],
);

/** What the owner sees as one album. Its fields come from its root editions. */
export const album = sqliteTable(
  "album",
  {
    id: text("id").primaryKey(),
    // The title of the original edition without edition words
    title: text("title"),
    artistName: text("artist_name"),
    // Null when no source states a type
    type: text("type", {
      enum: ["album", "ep", "single", "compilation", "live", "dj-mix", "broadcast"],
    }),
    // The earliest year of its editions
    year: integer("year"),
    artworkUrl: text("artwork_url"),
    mergedIntoId: text("merged_into_id"),
    ...entity,
  },
  (table) => [index("album_merged_into_idx").on(table.mergedIntoId)],
);

/** One release of an album with its own track list */
export const edition = sqliteTable(
  "edition",
  {
    id: text("id").primaryKey(),
    albumId: text("album_id"),
    title: text("title"),
    // The edition words of `title`, for example `Deluxe Edition`
    editionWords: text("edition_words"),
    artistName: text("artist_name"),
    date: text("date"),
    label: text("label"),
    upc: text("upc"),
    artworkUrl: text("artwork_url"),
    mergedIntoId: text("merged_into_id"),
    ...entity,
  },
  (table) => [
    index("edition_album_idx").on(table.albumId),
    index("edition_merged_into_idx").on(table.mergedIntoId),
    index("edition_upc_idx").on(table.upc),
  ],
);

/** A track of an edition, from its `tracks` assertion */
export const editionTrack = sqliteTable(
  "edition_track",
  {
    // `<edition_id>:track:<disc>:<position>`
    id: text("id").primaryKey(),
    editionId: text("edition_id").notNull(),
    disc: integer("disc").notNull(),
    position: integer("position").notNull(),
    // The bound recording; views resolve `merged_into_id`
    recordingId: text("recording_id").notNull(),
    title: text("title"),
    artistName: text("artist_name"),
    durationMs: integer("duration_ms"),
  },
  (table) => [
    index("edition_track_edition_idx").on(table.editionId, table.disc, table.position),
    index("edition_track_recording_idx").on(table.recordingId),
  ],
);

export const entityTypes = ["artist", "recording", "album", "edition"] as const;

/**
 * Identity decisions between entities. Replicated directly in the workspace scope; not a
 * projection. For each pair, an `admin` row wins over a `system` row, and an `admin` row on an
 * entity freezes all `system` rows from that entity.
 */
export const entityMerge = sqliteTable(
  "entity_merge",
  {
    // UUIDv5 of `merge:<entity_type>:<from_id>:<into_id>:<origin>`
    id: text("id").primaryKey(),
    entityType: text("entity_type", { enum: entityTypes }).notNull(),
    fromId: text("from_id").notNull(),
    intoId: text("into_id").notNull(),
    decision: text("decision", { enum: ["merge", "reject"] }).notNull(),
    origin: text("origin", { enum: ["system", "admin"] }).notNull(),
    // Artists: `shared_recording` (a provider credit and a MusicBrainz credit of one merge group)
    // and `url_rel` (a MusicBrainz URL relation), `name_search` (a search by name, confirmed by
    // shared songs)
    // Editions: `upc`. Albums: `edition_rule` (same artist, title and most songs).
    method: text("method", {
      enum: [
        "mbid_tag",
        "isrc",
        "mapper",
        "manual",
        "shared_recording",
        "url_rel",
        "upc",
        "edition_rule",
        "name_search",
      ],
    }).notNull(),
    confidence: real("confidence").notNull(),
    // Lookup response fields or tag names that support the decision
    evidence: text("evidence", { mode: "json" }),
    // Newer row with the same ID wins
    hlc: text("hlc").notNull(),
    changeSeq,
  },
  (table) => [
    index("entity_merge_from_idx").on(table.entityType, table.fromId),
    index("entity_merge_into_idx").on(table.entityType, table.intoId),
    index("entity_merge_change_idx").on(table.changeSeq),
  ],
);

/** External IDs for all entity types. Not unique per scheme: an ISRC can point to several recordings. */
export const identifier = sqliteTable(
  "identifier",
  {
    entityType: text("entity_type", { enum: entityTypes }).notNull(),
    entityId: text("entity_id").notNull(),
    scheme: text("scheme").notNull(),
    value: text("value").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.entityType, table.entityId, table.scheme, table.value] }),
    index("identifier_lookup_idx").on(table.scheme, table.value),
  ],
);
