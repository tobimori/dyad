import { credential, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { eq } from "drizzle-orm";
import { Clock, Effect, Schema } from "effect";

import { Jobs } from "./jobs.ts";
import { Providers } from "./providers.ts";

export const markWritesKind = "library.marks";

export const MarkWritesPayload = Schema.Struct({ provider: Schema.String });

// The wait collects the marks of a few seconds into one write
const writeDelayMs = 3000;

/**
 * Queues the write of the owner's new song marks to each account that this replica holds the
 * credential of. Marks from other replicas arrive as rows and go out from here.
 */
export const queueMarkWrites = Effect.gen(function* () {
  const db = yield* Database;
  const jobs = yield* Jobs;
  const providers = yield* Providers;
  const now = yield* Clock.currentTimeMillis;
  const held = yield* db
    .select({ provider: providerAccount.provider })
    .from(providerAccount)
    .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id));
  yield* Effect.forEach(
    held.filter(({ provider }) => providers.get(provider)?.marks !== undefined),
    ({ provider }) =>
      jobs.enqueue(markWritesKind, provider, { provider }, { runAt: now + writeDelayMs }),
    { discard: true },
  );
});
