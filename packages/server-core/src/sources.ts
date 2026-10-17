import { localFile, providerItem, recording, source, sourceVariant } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, SourceSummary } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import type { ProviderSource } from "@dyad/plugin";
import { and, eq, getColumns, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect, Option, Schema } from "effect";

import { boundRecordingId, sourceId, variantId } from "./ids.ts";
import type { CachedSource } from "./provider-cache.ts";
import { usableProviders } from "./providers.ts";
import { libraryAlbumRef, libraryArtistRef } from "./refs.ts";

// Projection columns before replication assigns revisions
const projection = { policyVersion: 1, revision: 0 };

// An upsert changes a row only when a value of `set` differs, so that later replication sees only
// real changes
const differs = (table: SQLiteTable, keys: ReadonlyArray<string>) => {
  const changes = Object.entries(getColumns(table))
    .filter(([key]) => keys.includes(key))
    .map(([, column]) => sql`${column} IS NOT excluded.${sql.identifier(column.name)}`);
  return sql`(${sql.join(changes, sql` OR `)})`;
};

/**
 * Adds or updates a source, its variant and its bound recording, and returns the source ID. All
 * writes of `source` and `source_variant` go through here.
 */
export const writeSource = (
  item: {
    readonly provider: string;
    readonly externalId: string;
    readonly kind: "stream" | "file";
    readonly title: string;
    readonly artist: string | null;
    readonly album: string | null;
    readonly durationMs: number | null;
  },
  variant: Omit<typeof sourceVariant.$inferInsert, "id" | "sourceId">,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const id = yield* sourceId(item.provider, item.externalId);
    const recordingId = yield* boundRecordingId(item.provider, item.externalId);
    const sourceRow = {
      id,
      provider: item.provider,
      externalId: item.externalId,
      kind: item.kind,
      recordingId,
      rawTitle: item.title,
      rawArtist: item.artist,
      rawAlbum: item.album,
      rawDurationMs: item.durationMs,
      ...projection,
    };
    const variantRow = { id: yield* variantId(id), sourceId: id, ...variant };

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(recording)
          .values({
            id: recordingId,
            origin: item.provider === "local" ? "local" : "provider",
            ...projection,
          })
          .onConflictDoNothing();
        yield* tx
          .insert(source)
          .values(sourceRow)
          .onConflictDoUpdate({
            target: source.id,
            set: sourceRow,
            setWhere: differs(source, Object.keys(sourceRow)),
          });
        yield* tx
          .insert(sourceVariant)
          .values(variantRow)
          .onConflictDoUpdate({
            target: sourceVariant.id,
            set: variantRow,
            setWhere: differs(sourceVariant, Object.keys(variantRow)),
          });
      }),
    );

    return id;
  });

export const writeProviderSource = (provider: string, item: ProviderSource) =>
  writeSource(
    {
      provider,
      externalId: item.externalId,
      kind: "stream",
      title: item.title,
      artist: item.artist,
      album: item.album,
      durationMs: item.durationMs,
    },
    {
      codec: item.codec,
      container: item.container,
      lossless: item.lossless,
      encrypted: item.encrypted,
    },
  );

export const addProviderSource = (cached: CachedSource) =>
  writeProviderSource(cached.provider, cached.source);

export const Tags = Schema.Record(Schema.String, Schema.String);

/**
 * The sources that `userId` can play, one row per source: a file on this replica, or a source of
 * a usable provider
 */
export const playableSources = (userId: UserId, match?: SQL, limit?: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* usableProviders(userId);

    const query = db
      .select({
        source,
        variant: sourceVariant,
        // From one of the files when a source has several
        tags: localFile.tags,
        albumArtistKey: localFile.albumArtistKey,
        artistKey: localFile.artistKey,
        albumKey: localFile.albumKey,
        // `source` has no artwork. A provider source has it only while its search result is cached.
        artworkUrl: sql<string | null>`json_extract(${providerItem.data}, '$.artworkUrl')`,
      })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .leftJoin(localFile, eq(localFile.sourceId, source.id))
      .leftJoin(providerItem, eq(providerItem.sourceId, source.id))
      .where(
        and(or(isNotNull(localFile.id), inArray(source.provider, [...providers.keys()])), match),
      )
      .groupBy(source.id)
      .$dynamic();

    return yield* limit === undefined ? query : query.limit(limit);
  });

export const sourceSummary = (row: {
  readonly source: typeof source.$inferSelect;
  readonly variant: typeof sourceVariant.$inferSelect;
  readonly artworkUrl: string | null;
  readonly albumArtistKey: string | null;
  readonly artistKey: string | null;
  readonly albumKey: string | null;
}) =>
  new SourceSummary({
    id: row.source.id,
    provider: row.source.provider,
    title: row.source.rawTitle,
    artist: row.source.rawArtist,
    album: row.source.rawAlbum,
    durationMs: row.source.rawDurationMs,
    codec: row.variant.codec,
    artworkUrl: row.artworkUrl,
    artistRef: row.artistKey === null ? null : libraryArtistRef(row.artistKey),
    albumRef:
      row.albumArtistKey === null || row.albumKey === null
        ? null
        : libraryAlbumRef(row.albumArtistKey, row.albumKey),
    explicit: false,
  });

/** The disc or track number. Tags such as `3/12` give the position and the total. */
export const position = (tags: typeof Tags.Type, key: "disc" | "track") =>
  Number.parseInt(tags[key] ?? "", 10) || null;

/** Local files only: provider sources come from other users' private libraries */
export const listSources = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const rows = yield* playableSources(principal.userId, isNotNull(localFile.id));

  const entries = rows.map((row) => {
    const tags = Option.getOrElse(Schema.decodeUnknownOption(Tags)(row.tags), () => ({}));
    return {
      summary: sourceSummary(row),
      disc: position(tags, "disc") ?? 1,
      track: position(tags, "track") ?? 0,
    };
  });

  return entries
    .toSorted(
      (a, b) =>
        (a.summary.artist ?? "").localeCompare(b.summary.artist ?? "") ||
        (a.summary.album ?? "").localeCompare(b.summary.album ?? "") ||
        a.disc - b.disc ||
        a.track - b.track ||
        (a.summary.title ?? "").localeCompare(b.summary.title ?? ""),
    )
    .map((entry) => entry.summary);
});
