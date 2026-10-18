import { integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { user } from "./auth.ts";

// A user links at most one account per provider. Replica-local, like the users.
export const providerAccount = sqliteTable(
  "provider_account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [uniqueIndex("provider_account_user_idx").on(table.userId, table.provider)],
);

/**
 * Secrets of a provider account, such as cookies. They never leave this replica. They are not
 * encrypted, because a key in the same data directory would not protect them.
 */
export const credential = sqliteTable("credential", {
  providerAccountId: text("provider_account_id")
    .primaryKey()
    .references(() => providerAccount.id, { onDelete: "cascade" }),
  values: text("values", { mode: "json" }).$type<Readonly<Record<string, string>>>().notNull(),
});
