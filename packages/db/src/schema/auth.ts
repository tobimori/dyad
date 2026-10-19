import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Replica-local: each replica has its own paired devices
export const device = sqliteTable("device", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  // SHA-256 of the device token. The token is random, so a slow hash adds nothing.
  tokenHash: text("token_hash").notNull().unique(),
  createdAt: integer("created_at").notNull(),
});
