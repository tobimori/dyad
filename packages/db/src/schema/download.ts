import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

import { device } from "./auth.ts";

// Replica-local, like the devices: the replica that a device checks in with owns its leases
export const deviceDownload = sqliteTable(
  "device_download",
  {
    deviceId: text("device_id")
      .notNull()
      .references(() => device.id, { onDelete: "cascade" }),
    sourceId: text("source_id").notNull(),
    // A `DownloadQuality` of `@dyad/domain`
    quality: text("quality").notNull(),
    // Null when the provider sets no lease
    leaseExpiresAt: integer("lease_expires_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [primaryKey({ columns: [table.deviceId, table.sourceId] })],
);
