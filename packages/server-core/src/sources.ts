import {
  artist,
  artistLookup,
  localFile,
  providerItem,
  recording,
  source,
  sourceVariant,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, RecordingId, SourceSummary, catalogArtistRef } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import type { CreditedArtist, ProviderSource } from "@dyad/plugin";
import { HlcClock } from "@dyad/sync";
import { and, eq, getColumns, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { Effect, Option, Schema } from "effect";

import { ParseEvidence, assertRecording } from "./assertions.ts";
import { AlbumType } from "./editions.ts";
import { boundRecordingId, musicbrainzArtistId, sourceId, variantId } from "./ids.ts";
import { updateRecording } from "./matching.ts";
import { normalizeIsrc } from "./normalize.ts";
import type { CachedSource } from "./provider-cache.ts";
import { Providers, linkedProviders } from "./providers.ts";
import { libraryAlbumRef, libraryArtistRef, providerAlbumRef, providerArtistRef } from "./refs.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";
import {
  parseVersionTitle,
  parsedCredit,
  parserRevision,
  versionedTitle,
} from "./version-titles.ts";

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

// Artists with each name key, in the catalog and in the MusicBrainz searches of this replica
const artistCounts = (keys: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const catalog = yield* db
      .select({ id: artist.id, nameKey: artist.nameKey })
      .from(artist)
      .where(and(inArray(artist.nameKey, keys), isNull(artist.mergedIntoId)));
    const lookups = yield* db
      .select()
      .from(artistLookup)
      .where(inArray(artistLookup.nameKey, keys));
    const searched = yield* Effect.forEach(lookups, (lookup) =>
      Effect.forEach(lookup.artists, (found) =>
        musicbrainzArtistId(found.mbid).pipe(Effect.map((id) => ({ id, nameKey: lookup.nameKey }))),
      ),
    );

    const ids = new Map(keys.map((key) => [key, new Set<string>()]));
    for (const row of [...catalog, ...searched.flat()]) ids.get(row.nameKey ?? "")?.add(row.id);
    return new Map([...ids].map(([key, found]) => [key, found.size]));
  });

const assertParsedTitle = (
  recordingId: string,
  item: {
    readonly provider: string;
    readonly externalId: string;
    readonly title: string;
    readonly artist: string | null;
    readonly durationMs: number | null;
    readonly uploader: CreditedArtist | null;
  },
) =>
  Effect.gen(function* () {
    const counts = new Map<string, number>();
    // The parser has no I/O, so it runs again with the counts of the name keys that it asked for
    const parsed = yield* Effect.gen(function* () {
      while (true) {
        const missing = new Set<string>();
        const result = parseVersionTitle({
          title: item.title,
          uploader: item.uploader?.name ?? null,
          // An uploader without an artist field gives its own name as the artist
          artists: item.artist === null || item.artist === item.uploader?.name ? [] : [item.artist],
          artistCount: (key) => counts.get(key) ?? (missing.add(key), 0),
          durationMs: item.durationMs,
        });
        if (missing.size === 0) return result;

        const found = yield* artistCounts([...missing]);
        for (const key of missing) counts.set(key, found.get(key) ?? 0);
      }
    });

    return yield* assertRecording(
      recordingId,
      "parse",
      `${item.provider}:${item.externalId}`,
      {
        title: versionedTitle(parsed),
        artist_credit: parsed.artists.length === 0 ? null : parsedCredit(parsed),
        versions: parsed.versions,
        mashup_parts: parsed.parts,
        uploader_role: item.uploader === null ? null : parsed.uploaderRole,
        set: parsed.set,
        series: parsed.series,
      },
      {
        confidence: parsed.confidence,
        originRevision: parserRevision,
        evidence: new ParseEvidence({
          title: item.title,
          artist: item.artist,
          uploader: item.uploader,
          artistSource: parsed.artistSource,
          removed: parsed.removed,
        }),
      },
    );
  });

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
    /** The account that uploaded the source, for providers with `uploads` */
    readonly uploader: CreditedArtist | null;
    /** Of the release of `album` */
    readonly albumType: typeof AlbumType.Type | null;
    readonly releaseDate: string | null;
  },
  variant: Omit<typeof sourceVariant.$inferInsert, "id" | "sourceId" | "hlc" | "changeSeq">,
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

        // Other server replicas take the newer write of a source or variant
        const [, sourceWritten = [], variantWritten = []] = written;
        if (sourceWritten.length > 0 || variantWritten.length > 0) {
          const stamp = { hlc: yield* (yield* HlcClock).next, changeSeq: yield* nextChangeSeq };
          if (sourceWritten.length > 0)
            yield* tx.update(source).set(stamp).where(eq(source.id, id));
          if (variantWritten.length > 0) {
            yield* tx.update(sourceVariant).set(stamp).where(eq(sourceVariant.id, variantRow.id));
          }
        }

        // A file asserts as its source, so that copies of the same audio on two replicas agree
        const local = item.provider === "local";
        // Uploaders type titles and artists as free text, so only the parse asserts them
        const uploads = (yield* Providers).get(item.provider)?.uploads === true;
        const metadata = {
          title: uploads ? null : item.title,
          artist_credit:
            uploads || item.artist === null
              ? null
              : {
                  name: item.artist,
                  artists: item.artists.map((artist) => ({ id: artist.id, name: artist.name })),
                },
          album: item.album,
          duration_ms: item.durationMs,
          isrc: item.isrc === null ? null : normalizeIsrc(item.isrc),
          artwork_url: item.artworkUrl,
          explicit: item.explicit,
          album_type: item.album === null ? null : item.albumType,
          release_date: item.album === null ? null : item.releaseDate,
        };
        yield* assertRecording(
          recordingId,
          local ? "local" : "provider",
          local ? id : `${item.provider}:${item.externalId}`,
          uploads ? { ...metadata, uploader: item.uploader } : metadata,
        );
        yield* assertParsedTitle(recordingId, item);
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
      uploader: item.uploader,
      albumType:
        item.albumType === null && item.albumSecondaryTypes.length === 0
          ? null
          : AlbumType.make({ primary: item.albumType, secondary: item.albumSecondaryTypes }),
      releaseDate: item.releaseDate,
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
 * a linked provider
 */
export const playableSources = (userId: UserId, match?: SQL, limit?: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* linkedProviders(userId);

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
        // The provider cache is local to each replica; the catalog artist is on every replica
        artistRoot: sql<string | null>`(
          SELECT coalesce(a.merged_into_id, a.id)
          FROM artist_credit_name AS n JOIN artist AS a ON a.id = n.artist_id
          WHERE n.artist_credit_id = ${canonical.artistCreditId} AND n.position = 0
            AND EXISTS (
              SELECT 1 FROM artist AS m
              WHERE coalesce(m.merged_into_id, m.id) = coalesce(a.merged_into_id, a.id)
                AND m.origin = 'provider'
            )
        )`,
        video: sql<number | null>`json_extract(${providerItem.data}, '$.video')`,
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
      providerName: providers.get(row.source.provider)?.name ?? null,
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
  readonly artistRoot: string | null;
  readonly providerName: string | null;
  readonly video: number | null;
}) => {
  const catalogArtist = row.artistRoot === null ? null : catalogArtistRef(row.artistRoot);
  const providerArtist =
    row.providerArtistId === null
      ? catalogArtist
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
    recordingId: row.source.recordingId === null ? null : RecordingId.make(row.source.recordingId),
    video: row.video === 1,
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
