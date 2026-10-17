import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { Schema } from "effect";

// Replica-local background jobs. Not replicated: each replica runs its own work, and other
// replicas see only the results.

export const job = sqliteTable(
  "job",
  {
    kind: text("kind").notNull(),
    // Unique within the kind, so that a second enqueue updates the waiting job
    key: text("key").notNull(),
    payload: text("payload", { mode: "json" }).$type<Schema.Json>().notNull(),
    // Higher runs first among due jobs
    priority: integer("priority").notNull(),
    nextRunAt: integer("next_run_at").notNull(),
    // Failed runs since the last success. Sets the backoff.
    attempts: integer("attempts").notNull(),
    // Safe text only: never URLs, credentials or provider responses
    lastError: text("last_error"),
    // Set while a run is in progress. An enqueue during the run clears it, so that the end of the
    // run does not delete or reschedule the new request.
    startedAt: integer("started_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.kind, table.key] }),
    index("job_next_run_idx").on(table.nextRunAt),
  ],
);
