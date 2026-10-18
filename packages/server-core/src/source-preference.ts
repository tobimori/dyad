import { sourcePreference } from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { UserId } from "@dyad/domain";
import { eq } from "drizzle-orm";
import { Effect } from "effect";

/** The user's provider order, best first. Empty until the user sets one. */
export const providerOrder = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ providerRanking: sourcePreference.providerRanking })
      .from(sourcePreference)
      .where(eq(sourcePreference.userId, userId));
    return row?.providerRanking ?? [];
  });
