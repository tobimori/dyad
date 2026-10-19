import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

import { changeSeq } from "./change-seq.ts";

// At most one account per provider. Replicated, so that every replica knows the linked
// providers; only the replica that linked it has the credential. Each write sets all fields.
export const providerAccount = sqliteTable(
  "provider_account",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    displayName: text("display_name").notNull(),
    createdAt: integer("created_at").notNull(),
    deleted: integer("deleted", { mode: "boolean" }).notNull().default(false),
    hlc: text("hlc").notNull(),
    changeSeq,
  },
  (table) => [
    uniqueIndex("provider_account_provider_idx").on(table.provider),
    index("provider_account_seq_idx").on(table.changeSeq),
  ],
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
