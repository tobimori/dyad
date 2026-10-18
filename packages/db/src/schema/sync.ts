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

/**
 * A paired server replica. The server that redeemed the pairing code connects: it has `url` and
 * `token`, and pulls from and pushes to the peer. The other server has `token_hash`.
 */
export const serverPeer = sqliteTable("server_peer", {
  replicaId: text("replica_id").primaryKey(),
  url: text("url"),
  // Credential of this replica: never in replicated rows or logs. Null after the peer revoked it.
  token: text("token"),
  // SHA-256 of the token that the peer sends
  tokenHash: text("token_hash").unique(),
  // The last epoch of the peer. Another epoch resets both cursors.
  epoch: text("epoch"),
  // Position in the peer's rows that this replica merged
  pulledSeq: integer("pulled_seq").notNull().default(0),
  pulledRowKey: text("pulled_row_key"),
  // Position in this replica's rows that the peer merged
  pushedSeq: integer("pushed_seq").notNull().default(0),
  pushedRowKey: text("pushed_row_key"),
  createdAt: integer("created_at").notNull(),
  syncedAt: integer("synced_at"),
  // Only an error tag, never a response or a URL with a credential
  error: text("error"),
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
