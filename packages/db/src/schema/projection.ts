import { integer } from "drizzle-orm/sqlite-core";

/** The resolution policy that canonical rows follow. A new version rebuilds them. */
export const policyVersion = 2;

// Columns of every row that a server replica derives from assertions
export const projection = {
  policyVersion: integer("policy_version").notNull(),
  // Change counter of the server replica that made the row. Clients keep one position per server.
  revision: integer("revision").notNull(),
};
