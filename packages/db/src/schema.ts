import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replicaIdentity = sqliteTable("replica_identity", {
  slot: integer("slot").primaryKey(),
  replicaId: text("replica_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  createdAt: integer("created_at").notNull(),
});
