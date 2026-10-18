import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";
import { projection } from "./projection.ts";

// Server replicas exchange sources: the newer `hlc` wins. Empty for rows from before replication.
const sourceHlc = () => text("hlc").notNull().default("");

// Shared source metadata. Access and file locations belong to replicas; see `local.ts`.

export const source = sqliteTable(
  "source",
  {
    // UUIDv5 of `<provider>:<external_id>`, or `local:<audio_hash>`
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    kind: text("kind", { enum: ["stream", "live", "file", "purchase"] }).notNull(),
    // The recording that the source binds to when it enters `source`. It never changes; matching
    // merges this recording into others with `entity_merge`.
    recordingId: text("recording_id"),
    // Set when the source is a known album position
    trackId: text("track_id"),
    rawTitle: text("raw_title"),
    rawArtist: text("raw_artist"),
    rawAlbum: text("raw_album"),
    rawDurationMs: integer("raw_duration_ms"),
    availability: text("availability", {
      enum: ["available", "unavailable", "region_locked", "removed"],
    })
      .notNull()
      .default("available"),
    checkedAt: integer("checked_at"),
    ...projection,
    hlc: sourceHlc(),
    changeSeq,
  },
  (table) => [
    uniqueIndex("source_provider_idx").on(table.provider, table.externalId),
    index("source_recording_idx").on(table.recordingId),
    index("source_track_idx").on(table.trackId),
    index("source_change_idx").on(table.changeSeq),
  ],
);

export const sourceVariant = sqliteTable(
  "source_variant",
  {
    id: text("id").primaryKey(),
    sourceId: text("source_id").notNull(),
    codec: text("codec").notNull(),
    container: text("container").notNull(),
    sampleRate: integer("sample_rate"),
    bitDepth: integer("bit_depth"),
    channels: integer("channels"),
    bitrate: integer("bitrate"),
    lossless: integer("lossless", { mode: "boolean" }).notNull(),
    encrypted: integer("encrypted", { mode: "boolean" }).notNull(),
    hlc: sourceHlc(),
    changeSeq,
  },
  (table) => [
    index("source_variant_source_idx").on(table.sourceId),
    index("source_variant_change_idx").on(table.changeSeq),
  ],
);

/**
 * One tracklist entry of a DJ set source. The set itself is the recording of the source; a
 * segment points to the recording that the DJ plays. Derived from the selected `source.tracklist`
 * assertion. Offsets belong to the source: another upload of the same set has other offsets.
 */
export const sourceSegment = sqliteTable(
  "source_segment",
  {
    sourceId: text("source_id").notNull(),
    position: integer("position").notNull(),
    // Null until matched, and for unknown tracks such as `ID - ID`
    recordingId: text("recording_id"),
    rawArtist: text("raw_artist"),
    rawTitle: text("raw_title"),
    // Null when the tracklist gives no time for the entry
    startMs: integer("start_ms"),
    endMs: integer("end_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.position] }),
    index("source_segment_recording_idx").on(table.recordingId),
  ],
);
