import { job, localFile, providerItem, source, sourceVariant } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { ProviderSource } from "@dyad/plugin";
import { and, asc, eq, gt } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";

import { projectRecordings } from "./assertions.ts";
import { boundRecordingId } from "./ids.ts";
import { Jobs } from "./jobs.ts";
import { matchingLayer, resolveRoots } from "./matching.ts";
import { Tags, tagIdentifiers, writeProviderSource, writeSource } from "./sources.ts";

const backfillKind = "catalog.backfill";
const batchSize = 50;

// The next batch starts after this source ID, so that a restart continues there
const BackfillPayload = Schema.Struct({ after: Schema.NullOr(Schema.String) });

/**
 * Writes each source again, also sources without a bound recording, and resolves their merge
 * groups. Unchanged data writes nothing. Other jobs run between batches.
 */
const runBackfill = ({ after }: typeof BackfillPayload.Type) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;

    const rows = yield* db
      .select({
        source,
        variant: sourceVariant,
        tags: localFile.tags,
        cached: providerItem.data,
      })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .leftJoin(localFile, eq(localFile.sourceId, source.id))
      .leftJoin(providerItem, eq(providerItem.sourceId, source.id))
      .where(after === null ? undefined : gt(source.id, after))
      .groupBy(source.id)
      .orderBy(asc(source.id))
      .limit(batchSize);

    // The cached provider data has the ISRC, the artwork and the artist IDs. Without it, only the
    // raw fields of `source` remain.
    yield* Effect.forEach(
      rows,
      (row) => {
        const cached = Schema.decodeUnknownOption(ProviderSource)(row.cached);
        if (row.source.provider !== "local" && Option.isSome(cached)) {
          return writeProviderSource(row.source.provider, cached.value);
        }

        const tags = Option.getOrElse(Schema.decodeUnknownOption(Tags)(row.tags), () => ({}));
        const { id: _id, sourceId: _sourceId, ...variant } = row.variant;
        return writeSource(
          {
            provider: row.source.provider,
            externalId: row.source.externalId,
            kind: row.source.kind === "file" ? "file" : "stream",
            title: row.source.rawTitle ?? "",
            artist: row.source.rawArtist,
            artists: [],
            album: row.source.rawAlbum,
            durationMs: row.source.rawDurationMs,
            ...tagIdentifiers(tags),
            artworkUrl: null,
            explicit: null,
          },
          variant,
        );
      },
      { discard: true },
    );

    // Merge rows can also come from an admin, outside of `writeSource`
    const boundIds = yield* Effect.forEach(rows, (row) =>
      boundRecordingId(row.source.provider, row.source.externalId),
    );
    yield* projectRecordings(yield* resolveRoots(boundIds));

    const last = rows.at(-1);
    if (rows.length < batchSize || last === undefined) {
      return yield* Effect.logInfo("Catalog backfill finished");
    }
    yield* jobs.enqueue(backfillKind, backfillKind, { after: last.source.id }, { priority: -1 });
  });

/**
 * Build it after the plugins, so that ISRC lookups find the MusicBrainz plugin. Each start runs the
 * backfill once, or continues the run that a restart stopped.
 */
export const catalogLayer = Layer.mergeAll(
  matchingLayer,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const db = yield* Database;
      const jobs = yield* Jobs;

      yield* jobs.register(backfillKind, BackfillPayload, runBackfill);

      const [waiting] = yield* db
        .select({ key: job.key })
        .from(job)
        .where(and(eq(job.kind, backfillKind), eq(job.key, backfillKind)));
      if (waiting === undefined) {
        yield* jobs.enqueue(backfillKind, backfillKind, { after: null }, { priority: -1 });
      }
    }).pipe(Effect.orDie),
  ),
);
