import { artist, artistLookup } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { and, inArray, isNull } from "drizzle-orm";
import { Effect } from "effect";

import { musicbrainzArtistId } from "./ids.ts";
import { parseVersionTitle } from "./version-titles.ts";

// Artists with each name key, in the catalog and in the MusicBrainz searches of this replica
const artistCounts = Effect.fn("artistCounts")(function* (keys: ReadonlyArray<string>) {
  const db = yield* Database;
  const catalog = yield* db
    .select({ id: artist.id, nameKey: artist.nameKey })
    .from(artist)
    .where(and(inArray(artist.nameKey, keys), isNull(artist.mergedIntoId)));
  const lookups = yield* db.select().from(artistLookup).where(inArray(artistLookup.nameKey, keys));
  const searched = yield* Effect.forEach(lookups, (lookup) =>
    Effect.forEach(lookup.artists, (found) =>
      musicbrainzArtistId(found.mbid).pipe(Effect.map((id) => ({ id, nameKey: lookup.nameKey }))),
    ),
  );

  const ids = new Map(keys.map((key) => [key, new Set<string>()]));
  for (const row of [...catalog, ...searched.flat()]) ids.get(row.nameKey ?? "")?.add(row.id);
  return new Map([...ids].map(([key, found]) => [key, found.size]));
});

/** `parseVersionTitle` with the counts of the catalog artists that it asks for */
export const parseUploadTitle = Effect.fn("parseUploadTitle")(function* (
  input: Omit<Parameters<typeof parseVersionTitle>[0], "artistCount">,
) {
  const counts = new Map<string, number>();
  // The parser has no I/O, so it runs again with the counts of the name keys that it asked for
  while (true) {
    const missing = new Set<string>();
    const result = parseVersionTitle({
      ...input,
      artistCount: (key) => counts.get(key) ?? (missing.add(key), 0),
    });
    if (missing.size === 0) return result;

    const found = yield* artistCounts([...missing]);
    for (const key of missing) counts.set(key, found.get(key) ?? 0);
  }
});
