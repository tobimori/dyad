import { index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** One field value of one entity from one origin. Replicated in the workspace scope. */
export const catalogAssertion = sqliteTable(
  "catalog_assertion",
  {
    // UUIDv5 of `assertion:<entity_type>:<entity_id>:<field>:<origin>:<origin_ref>`
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    // A canonical column, or a relation such as `track.recording_id` or `artist_credit.names`
    field: text("field").notNull(),
    // Null states that the origin has no value
    value: text("value", { mode: "json" }),
    // Resolution rank: admin, musicbrainz, provider, local
    origin: text("origin", { enum: ["admin", "musicbrainz", "provider", "local"] }).notNull(),
    // `workspace` for admin edits, MBID, `<provider>:<external_id>`, or local source ID
    originRef: text("origin_ref").notNull(),
    originRevision: text("origin_revision"),
    evidence: text("evidence", { mode: "json" }),
    confidence: real("confidence").notNull(),
    authorUserId: text("author_user_id").notNull(),
    authorReplicaId: text("author_replica_id").notNull(),
    // Newer assertion with the same ID wins
    hlc: text("hlc").notNull(),
    // Withdrawn, and ignored by resolution. A null value instead states that there is no value.
    retracted: integer("retracted", { mode: "boolean" }).notNull().default(false),
    schemaVersion: integer("schema_version").notNull(),
  },
  (table) => [
    index("catalog_assertion_entity_idx").on(table.entityType, table.entityId, table.field),
    index("catalog_assertion_origin_idx").on(table.originRef),
  ],
);
