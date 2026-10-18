import { localFile, providerItem, recording, source, sourceVariant } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, SourceSummary } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import type { ProviderSource } from "@dyad/plugin";
import { and, eq, getColumns, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect, Option, Schema } from "effect";

import { RecordingMetadata, assertRecording } from "./assertions.ts";
import { boundRecordingId, sourceId, variantId } from "./ids.ts";
import { updateRecording } from "./matching.ts";
import { normalizeIsrc } from "./normalize.ts";
import type { CachedSource } from "./provider-cache.ts";
import { usableProviders } from "./providers.ts";
import { libraryAlbumRef, libraryArtistRef, providerAlbumRef, providerArtistRef } from "./refs.ts";
import { touchGroups } from "./sync-counter.ts";

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
 * Writes a source, its variant and recording, then asserts and matches the metadata. All writes
 * of `source` and `source_variant` go through here.
 */
export const writeSource = (
  item: {
    readonly provider: string;
    readonly externalId: string;
    readonly kind: "stream" | "file";
    readonly title: string;
    readonly artist: string | null;
    /** The artists of `artist` with provider IDs */
    readonly artists: ReadonlyArray<{ readonly id: string; readonly name: string }>;
    readonly album: string | null;
    readonly durationMs: number | null;
    /** As the provider or the tags give it */
    readonly isrc: string | null;
    /** The recording MBID of a file tag */
    readonly mbid: string | null;
    readonly artworkUrl: string | null;
    readonly explicit: boolean | null;
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
        const written = yield* Effect.all([
          tx
            .insert(recording)
            .values({
              id: recordingId,
              origin: item.provider === "local" ? "local" : "provider",
              ...projection,
            })
            .onConflictDoNothing()
            .returning({ id: recording.id }),
          tx
            .insert(source)
            .values(sourceRow)
            .onConflictDoUpdate({
              target: source.id,
              set: sourceRow,
              setWhere: differs(source, Object.keys(sourceRow)),
            })
            .returning({ id: source.id }),
          tx
            .insert(sourceVariant)
            .values(variantRow)
            .onConflictDoUpdate({
              target: sourceVariant.id,
              set: variantRow,
              setWhere: differs(sourceVariant, Object.keys(variantRow)),
            })
            .returning({ id: sourceVariant.id }),
        ]);

        // A file asserts as its source, so that copies of the same audio on two replicas agree
        const local = item.provider === "local";
        yield* assertRecording(
          recordingId,
          local ? "local" : "provider",
          local ? id : `${item.provider}:${item.externalId}`,
          new RecordingMetadata({
            title: item.title,
            artistCredit:
              item.artist === null
                ? null
                : {
                    name: item.artist,
                    artists: item.artists.map((artist) => ({ id: artist.id, name: artist.name })),
                  },
            album: item.album,
            durationMs: item.durationMs,
            isrc: item.isrc === null ? null : normalizeIsrc(item.isrc),
            artworkUrl: item.artworkUrl,
            explicit: item.explicit,
          }),
        );
        yield* updateRecording(recordingId, item.mbid);
        if (written.some((rows) => rows.length > 0)) yield* touchGroups([recordingId]);
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
      artists: item.artists,
      album: item.album,
      durationMs: item.durationMs,
      isrc: item.isrc,
      mbid: null,
      artworkUrl: item.artworkUrl,
      explicit: item.explicit,
    },
    {
      codec: item.codec,
      container: item.container,
      lossless: item.lossless,
      encrypted: item.encrypted,
      bitrate: item.bitrate,
    },
  );

export const addProviderSource = (cached: CachedSource) =>
  writeProviderSource(cached.provider, cached.source);

export const Tags = Schema.Record(Schema.String, Schema.String);

const mbidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * FFmpeg (`node-av` 6.1.1) keeps the ID3 frame name `tsrc` and does not read the MP3 `UFID`
 * frame where Picard writes the recording MBID.
 */
export const tagIdentifiers = (tags: typeof Tags.Type) => {
  // Picard calls the recording MBID `musicbrainz_trackid` in Vorbis comments
  const mbid = (tags.musicbrainz_trackid ?? tags["musicbrainz track id"])?.trim().toLowerCase();
  return {
    isrc: tags.isrc ?? tags.tsrc ?? null,
    mbid: mbid !== undefined && mbidPattern.test(mbid) ? mbid : null,
  };
};

// The canonical recording of each source, for its fields
const bound = alias(recording, "bound");
const canonical = alias(recording, "canonical");

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
        canonical: {
          title: canonical.title,
          artist: canonical.artistName,
          album: canonical.album,
          explicit: canonical.explicit,
        },
        // The cached search result has artwork for sources from before assertions
        artworkUrl: sql<
          string | null
        >`coalesce(${canonical.artworkUrl}, json_extract(${providerItem.data}, '$.artworkUrl'))`,
        // The same rule as `cachedSummary`
        providerArtistId: sql<
          string | null
        >`coalesce(json_extract(${providerItem.data}, '$.artists[0].id'), json_extract(${providerItem.data}, '$.uploader.id'))`,
        providerAlbumId: sql<string | null>`json_extract(${providerItem.data}, '$.albumId')`,
      })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .leftJoin(localFile, eq(localFile.sourceId, source.id))
      .leftJoin(providerItem, eq(providerItem.sourceId, source.id))
      .leftJoin(bound, eq(bound.id, source.recordingId))
      .leftJoin(canonical, eq(canonical.id, sql`coalesce(${bound.mergedIntoId}, ${bound.id})`))
      .where(
        and(or(isNotNull(localFile.id), inArray(source.provider, [...providers.keys()])), match),
      )
      .groupBy(source.id)
      .$dynamic();

    const rows = yield* limit === undefined ? query : query.limit(limit);
    return rows.map((row) => ({
      ...row,
      tags:
        row.tags === null
          ? null
          : Option.getOrElse(Schema.decodeUnknownOption(Tags)(row.tags), () => ({})),
      providerName: providers.get(row.source.provider)?.provider.name ?? null,
    }));
  });

/** Canonical fields of the source's recording first. The duration is the source's own. */
export const sourceSummary = (row: {
  readonly source: typeof source.$inferSelect;
  readonly variant: typeof sourceVariant.$inferSelect;
  readonly canonical: {
    readonly title: string | null;
    readonly artist: string | null;
    readonly album: string | null;
    readonly explicit: boolean | null;
  } | null;
  readonly artworkUrl: string | null;
  readonly albumArtistKey: string | null;
  readonly artistKey: string | null;
  readonly albumKey: string | null;
  readonly providerArtistId: string | null;
  readonly providerAlbumId: string | null;
  readonly providerName: string | null;
}) => {
  const providerArtist =
    row.providerArtistId === null
      ? null
      : providerArtistRef(row.source.provider, row.providerArtistId);
  const providerAlbum =
    row.providerAlbumId === null
      ? null
      : providerAlbumRef(row.source.provider, row.providerAlbumId);

  return new SourceSummary({
    id: row.source.id,
    provider: row.source.provider,
    title: row.canonical?.title ?? row.source.rawTitle,
    artist: row.canonical?.artist ?? row.source.rawArtist,
    album: row.canonical?.album ?? row.source.rawAlbum,
    durationMs: row.source.rawDurationMs,
    codec: row.variant.codec,
    artworkUrl: row.artworkUrl,
    artistRef: row.artistKey === null ? providerArtist : libraryArtistRef(row.artistKey),
    albumRef:
      row.albumArtistKey === null || row.albumKey === null
        ? providerAlbum
        : libraryAlbumRef(row.albumArtistKey, row.albumKey),
    explicit: row.canonical?.explicit ?? false,
    providerName: row.providerName,
  });
};

/** The disc or track number. Tags such as `3/12` give the position and the total. */
export const position = (tags: typeof Tags.Type, key: "disc" | "track") =>
  Number.parseInt(tags[key] ?? "", 10) || null;

/** Local files only: provider sources come from other users' private libraries */
export const listSources = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const rows = yield* playableSources(principal.userId, isNotNull(localFile.id));
  return rows.map(sourceSummary);
});
