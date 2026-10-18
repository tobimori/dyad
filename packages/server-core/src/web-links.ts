import { source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { WebLink } from "@dyad/domain";
import { eq, inArray } from "drizzle-orm";
import { Effect } from "effect";

import { Providers } from "./providers.ts";
import { recordingGroup } from "./sets.ts";

/** The source's own page first, then one page for each other provider of its recording */
export const webLinks = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;
    const [own] = yield* db
      .select({
        provider: source.provider,
        externalId: source.externalId,
        recordingId: source.recordingId,
      })
      .from(source)
      .where(eq(source.id, sourceId));
    if (own === undefined) return [];

    const others =
      own.recordingId === null
        ? []
        : yield* db
            .select({
              provider: source.provider,
              externalId: source.externalId,
              recordingId: source.recordingId,
            })
            .from(source)
            .where(inArray(source.recordingId, yield* recordingGroup(own.recordingId)));

    const links = new Map<string, WebLink>();
    for (const row of [own, ...others]) {
      const provider = providers.get(row.provider);
      const url = provider?.webUrl?.(row.externalId) ?? null;
      if (provider !== undefined && url !== null && !links.has(row.provider)) {
        links.set(row.provider, new WebLink({ providerName: provider.name, url }));
      }
    }
    return [...links.values()];
  });
