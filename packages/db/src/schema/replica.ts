import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const replicaIdentity = sqliteTable("replica_identity", {
  slot: integer("slot").primaryKey(),
  replicaId: text("replica_id").notNull().unique(),
  workspaceId: text("workspace_id").notNull(),
  createdAt: integer("created_at").notNull(),
  // Random. A restore from a backup must set a new value, so that clients load all rows again.
  epoch: text("epoch").notNull(),
  // The last value of the `change_seq` counter
  changeSeq: integer("change_seq").notNull().default(0),
});
