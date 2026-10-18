import { integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

/** A client replica, bound to the device that used it first */
export const replica = sqliteTable("replica", {
  replicaId: text("replica_id").primaryKey(),
  userId: text("user_id").notNull(),
  deviceId: text("device_id").notNull(),
  // The last mutation that this server admitted or rejected
  lastMutationId: integer("last_mutation_id").notNull().default(0),
  createdAt: integer("created_at").notNull(),
});

/** Kept until the client pushes a later mutation, so that a retry after a lost response gets it */
export const syncRejection = sqliteTable(
  "sync_rejection",
  {
    replicaId: text("replica_id").notNull(),
    mutationId: integer("mutation_id").notNull(),
    reason: text("reason", { enum: ["forbidden", "not_found"] }).notNull(),
  },
  (table) => [primaryKey({ columns: [table.replicaId, table.mutationId] })],
);
