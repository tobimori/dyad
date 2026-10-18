import {
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

// Replica-local cache of provider search results. Not replicated: an item enters the shared
// `source` table only when it is played. The server deletes rows older than 7 days when it starts
// and then every 6 hours, but keeps the rows of played sources.

export const providerItem = sqliteTable(
  "provider_item",
  {
    // The ID that the source gets in `source` when it is played
    sourceId: text("source_id").primaryKey(),
    provider: text("provider").notNull(),
    externalId: text("external_id").notNull(),
    isrc: text("isrc"),
    // The fields of the plugin's `ProviderSource`
    data: text("data", { mode: "json" }).notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [
    uniqueIndex("provider_item_external_idx").on(table.provider, table.externalId),
    index("provider_item_isrc_idx").on(table.isrc),
  ],
);

// Artist and album pages of the plugins, swept like `provider_item`. The server writes the tracks
// of a page into `provider_item` first, so that they expire after the page.
export const providerPage = sqliteTable(
  "provider_page",
  {
    provider: text("provider").notNull(),
    kind: text("kind", { enum: ["artist", "album"] }).notNull(),
    externalId: text("external_id").notNull(),
    // The plugin's `ProviderArtist` or `ProviderAlbum`
    data: text("data", { mode: "json" }).notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.provider, table.kind, table.externalId] })],
);
