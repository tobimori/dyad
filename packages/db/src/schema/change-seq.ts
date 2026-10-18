import { integer } from "drizzle-orm/sqlite-core";

/**
 * The `replica_identity.change_seq` of the server transaction that last changed the row. Clients
 * pull the rows after a cursor of it, and store the server value.
 */
export const changeSeq = integer("change_seq").notNull().default(0);
