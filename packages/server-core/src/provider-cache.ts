import { playbackSession, providerItem, providerPage, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { RecordingId, SourceSummary } from "@dyad/domain";
import { ProviderSource } from "@dyad/plugin";
import { and, eq, inArray, lt, notInArray, sql } from "drizzle-orm";
import { Clock, Data, Effect, Layer, Option, Schema } from "effect";

import { boundRecordingId, sourceId } from "./ids.ts";
import { Jobs } from "./jobs.ts";
import { normalizeIsrc } from "./normalize.ts";
import { providerAlbumRef, providerArtistRef } from "./refs.ts";
import { parseUploadTitle } from "./upload-titles.ts";
import { parsedCredit, versionedTitle } from "./version-titles.ts";

// Results of played sources do not expire, because `source` has no artwork and no ISRC. The TTL
// only limits the size of the cache.
const cacheLifetimeMs = 7 * 24 * 60 * 60 * 1000;
const sweepIntervalMs = 6 * 60 * 60 * 1000;
const sweepJob = "provider-cache.sweep";

/** A search result in the provider cache of this replica */
export class CachedSource extends Data.Class<{
  /** The ID that the result gets in `source` when it is played */
  readonly sourceId: string;
  /** The recording that `writeSource` binds the source to */
  readonly recordingId: RecordingId;
  readonly provider: string;
  /** Normalized with `normalizeIsrc` */
  readonly isrc: string | null;
  readonly source: ProviderSource;
}> {}

/** The artist ref follows the same rule as `playableSources` */
// Only providers with `uploads` report an uploader. The same parse as `writeSource`.
const parseCached = (item: CachedSource) => {
  const { uploader } = item.source;
  return uploader === null
    ? Effect.succeed(null)
    : parseUploadTitle({
        title: item.source.title,
        uploader: uploader.name,
        artists:
          item.source.artist === null || item.source.artist === uploader.name
            ? []
            : [item.source.artist],
        durationMs: item.source.durationMs,
      });
};

/**
 * The artist ID that the result credits, as in `writeSource`: the first artist, or the uploader
 * when the title names it as the artist. `null` for a reupload.
 */
export const cachedArtistId = (item: CachedSource) =>
  Effect.gen(function* () {
    const { uploader } = item.source;
    if (uploader === null) return item.source.artists[0]?.id ?? null;
    return (yield* parseCached(item))?.uploaderRole === "artist" ? uploader.id : null;
  });

export const cachedSummary = (item: CachedSource, providerName: string) =>
  Effect.gen(function* () {
    const artist = item.source.artists[0] ?? item.source.uploader;
    const albumId = item.source.albumId;
    const parsed = yield* parseCached(item);

    return new SourceSummary({
      id: item.sourceId,
      provider: item.provider,
      title: parsed === null ? item.source.title : versionedTitle(parsed),
      artist:
        parsed === null || parsed.artists.length === 0
          ? item.source.artist
          : parsedCredit(parsed).name,
      album: item.source.album,
      durationMs: item.source.durationMs,
      codec: item.source.codec,
      artworkUrl: item.source.artworkUrl,
      artistRef: artist === null ? null : providerArtistRef(item.provider, artist.id),
      albumRef: albumId === null ? null : providerAlbumRef(item.provider, albumId),
      explicit: item.source.explicit ?? false,
      providerName,
      recordingId: item.recordingId,
      video: item.source.video,
      series: parsed?.series?.name ?? null,
    });
  });

export const toCachedSource = (provider: string, source: ProviderSource) =>
  Effect.gen(function* () {
    const id = yield* sourceId(provider, source.externalId);
    const recordingId = RecordingId.make(yield* boundRecordingId(provider, source.externalId));
    const isrc = source.isrc === null ? null : normalizeIsrc(source.isrc);
    return new CachedSource({ sourceId: id, recordingId, provider, isrc, source });
  });

/** Replaces the cached results of `provider` with the same external IDs, or keeps them with `keepKnown` */
export const cacheProviderSources = (
  provider: string,
  sources: ReadonlyArray<ProviderSource>,
  options: { readonly keepKnown?: true } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const fetchedAt = yield* Clock.currentTimeMillis;

    // Some lists give no duration, for example the YouTube home shelves. The known one stays.
    const missing = sources.flatMap((source) =>
      source.durationMs === null ? [source.externalId] : [],
    );
    const known = new Map(
      missing.length === 0
        ? []
        : (yield* db
            .select({
              externalId: providerItem.externalId,
              durationMs: sql<number | null>`json_extract(${providerItem.data}, '$.durationMs')`,
            })
            .from(providerItem)
            .where(
              and(eq(providerItem.provider, provider), inArray(providerItem.externalId, missing)),
            )).map((row) => [row.externalId, row.durationMs]),
    );
    const cached = yield* Effect.forEach(sources, (source) =>
      toCachedSource(
        provider,
        source.durationMs === null
          ? new ProviderSource({ ...source, durationMs: known.get(source.externalId) ?? null })
          : source,
      ),
    );
    const rows = yield* Effect.forEach(cached, (item) =>
      Effect.gen(function* () {
        const data = yield* Schema.encodeEffect(ProviderSource)(item.source).pipe(Effect.orDie);
        return {
          sourceId: item.sourceId,
          provider,
          externalId: item.source.externalId,
          isrc: item.isrc,
          data,
          fetchedAt,
        };
      }),
    );

    yield* db.transaction((tx) =>
      Effect.forEach(
        rows,
        (row) => {
          const insert = tx.insert(providerItem).values(row);
          return options.keepKnown === true
            ? insert.onConflictDoNothing()
            : insert.onConflictDoUpdate({ target: providerItem.sourceId, set: row });
        },
        { discard: true },
      ),
    );

    return cached;
  });

/** The cached search result with this source ID */
export const cachedProviderSource = (id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ provider: providerItem.provider, isrc: providerItem.isrc, data: providerItem.data })
      .from(providerItem)
      .where(eq(providerItem.sourceId, id))
      .limit(1);
    if (row === undefined) return Option.none();

    const source = yield* Schema.decodeUnknownEffect(ProviderSource)(row.data).pipe(Effect.orDie);
    const recordingId = RecordingId.make(yield* boundRecordingId(row.provider, source.externalId));
    return Option.some(
      new CachedSource({
        sourceId: id,
        recordingId,
        provider: row.provider,
        isrc: row.isrc,
        source,
      }),
    );
  });

/** Deletes expired search results and pages when the server starts and then every 6 hours */
export const providerCacheSweepLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;

    yield* jobs.register(sweepJob, Schema.Struct({}), () =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* db.delete(providerPage).where(lt(providerPage.fetchedAt, now - cacheLifetimeMs));
        yield* db.delete(providerItem).where(
          and(
            lt(providerItem.fetchedAt, now - cacheLifetimeMs),
            notInArray(providerItem.sourceId, db.select({ id: source.id }).from(source)),
            // A queued search result plays from this cache, maybe weeks later
            sql`${providerItem.sourceId} NOT IN (SELECT json_extract(entry.value, '$.source.id') FROM ${playbackSession}, json_each(${playbackSession.entries}) AS entry)`,
          ),
        );
        yield* jobs.enqueue(sweepJob, sweepJob, {}, { runAt: now + sweepIntervalMs });
      }),
    );

    // Enqueue keeps the earlier run time, so this also moves a waiting run from before the restart to now
    yield* jobs.enqueue(sweepJob, sweepJob, {});
  }).pipe(Effect.orDie),
);
