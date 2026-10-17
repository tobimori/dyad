import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

// Replica-local: each server replica has its own users and devices

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  username: text("username").notNull().unique(),
  // `pbkdf2-sha256$<iterations>$<salt>$<hash>`, so that the parameters can change later
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "member"] }).notNull(),
  createdAt: integer("created_at").notNull(),
});

export const device = sqliteTable(
  "device",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // SHA-256 of the device token. The token is random, so a slow hash adds nothing.
    tokenHash: text("token_hash").notNull().unique(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("device_user_idx").on(table.userId)],
);
