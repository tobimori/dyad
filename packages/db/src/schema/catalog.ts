import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
    ...entity,
  },
  (table) => [index("artist_local_key_idx").on(table.localKey)],
);

export const artistCredit = sqliteTable("artist_credit", {
  id: text("id").primaryKey(),
  ...projection,
});

export const artistCreditName = sqliteTable(
  "artist_credit_name",
  {
    artistCreditId: text("artist_credit_id").notNull(),
    position: integer("position").notNull(),
    artistId: text("artist_id").notNull(),
    creditedAs: text("credited_as").notNull(),
    joinPhrase: text("join_phrase").notNull().default(""),
  },
  (table) => [
    primaryKey({ columns: [table.artistCreditId, table.position] }),
    index("artist_credit_name_artist_idx").on(table.artistId),
  ],
);

export const recording = sqliteTable(
  "recording",
  {
    id: text("id").primaryKey(),
    title: text("title"),
    artistCreditId: text("artist_credit_id"),
    durationMs: integer("duration_ms"),
    disambiguation: text("disambiguation"),
    // The credit as one text, for example `A feat. B`. Artist entities need corroborated identity.
    artistName: text("artist_name"),
    // Album and artwork stay on the recording until sources bind to tracks and releases
    album: text("album"),
    artworkUrl: text("artwork_url"),
    explicit: integer("explicit", { mode: "boolean" }),
    // Root of the merge tree, resolved from the effective `entity_merge` edges. Null for a root.
    mergedIntoId: text("merged_into_id"),
    ...entity,
  },
  (table) => [
    index("recording_artist_credit_idx").on(table.artistCreditId),
    index("recording_merged_into_idx").on(table.mergedIntoId),
    index("recording_revision_idx").on(table.revision),
  ],
);

export const releaseGroup = sqliteTable(
  "release_group",
  {
    id: text("id").primaryKey(),
    // Binding key for local release groups: `<album_artist_credit_id>:<norm(album)>`.
    // Resolved from `local_key` assertions.
    localKey: text("local_key"),
    title: text("title"),
    artistCreditId: text("artist_credit_id"),
    // Null means unknown; `other` is a known classification
    primaryType: text("primary_type", {
      enum: ["album", "single", "ep", "broadcast", "other"],
    }),
    classificationStatus: text("classification_status", { enum: ["resolved", "uncertain"] })
      .notNull()
      .default("uncertain"),
    secondaryTypes: text("secondary_types", { mode: "json" })
      .$type<ReadonlyArray<string>>()
      .notNull()
      .default([]),
    firstReleaseDate: text("first_release_date"),
    ...entity,
  },
  (table) => [
    index("release_group_artist_credit_idx").on(table.artistCreditId),
    index("release_group_local_key_idx").on(table.localKey),
  ],
);

export const release = sqliteTable(
  "release",
  {
    id: text("id").primaryKey(),
    releaseGroupId: text("release_group_id"),
    title: text("title"),
    artistCreditId: text("artist_credit_id"),
    date: text("date"),
    country: text("country"),
    // MusicBrainz release status: official, promotion, bootleg, pseudo-release
    releaseStatus: text("release_status"),
    label: text("label"),
    catalogNumber: text("catalog_number"),
    ...entity,
  },
  (table) => [
    index("release_release_group_idx").on(table.releaseGroupId),
    index("release_artist_credit_idx").on(table.artistCreditId),
  ],
);

export const medium = sqliteTable(
  "medium",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id"),
    position: integer("position"),
    format: text("format"),
    title: text("title"),
    ...projection,
  },
  (table) => [index("medium_release_idx").on(table.releaseId, table.position)],
);

export const track = sqliteTable(
  "track",
  {
    id: text("id").primaryKey(),
    mediumId: text("medium_id"),
    position: integer("position"),
    // Display number such as "A1"
    number: text("number"),
    title: text("title"),
    artistCreditId: text("artist_credit_id"),
    recordingId: text("recording_id"),
    durationMs: integer("duration_ms"),
    ...entity,
  },
  (table) => [
    index("track_medium_idx").on(table.mediumId, table.position),
    index("track_recording_idx").on(table.recordingId),
  ],
);

export const entityTypes = ["artist", "recording", "release_group", "release", "track"] as const;

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
    method: text("method", { enum: ["mbid_tag", "isrc", "mapper", "manual"] }).notNull(),
    confidence: real("confidence").notNull(),
    // Lookup response fields or tag names that support the decision
    evidence: text("evidence", { mode: "json" }),
    // Null for `system` rows
    authorUserId: text("author_user_id"),
    // Newer row with the same ID wins
    hlc: text("hlc").notNull(),
  },
  (table) => [
    index("entity_merge_from_idx").on(table.entityType, table.fromId),
    index("entity_merge_into_idx").on(table.entityType, table.intoId),
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
