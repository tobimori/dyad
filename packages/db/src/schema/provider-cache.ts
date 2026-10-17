import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

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
