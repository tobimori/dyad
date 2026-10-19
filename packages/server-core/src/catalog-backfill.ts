import { catalogAssertion, job, localFile, providerItem, source, sourceVariant } from "@dyad/db";
import { Database, ReplicaDatabase } from "@dyad/db/node";
import { ProviderSource } from "@dyad/plugin";
import { and, asc, eq, gt } from "drizzle-orm";
import { Effect, Layer, Option, Schema } from "effect";

import { artistLinksLayer } from "./artist-links.ts";
import { matchArtistsOf } from "./artist-matching.ts";
import { uncreditedRecordings } from "./artists.ts";
import { ParseEvidence, projectRecordings } from "./assertions.ts";
import { tagAlbumType, tagReleaseDate } from "./editions.ts";
import { assertionId, boundRecordingId } from "./ids.ts";
import { Jobs } from "./jobs.ts";
import { matchingLayer, resolveRoots } from "./matching.ts";
import { editionsLayer } from "./albums.ts";
import { copyDiscoveryLayer } from "./source-copies.ts";
import { Tags, tagIdentifiers, writeProviderSource, writeSource } from "./sources.ts";
import { assertSegmentMatches } from "./tracklists.ts";

const backfillKind = "catalog.backfill";
const batchSize = 50;

// The next batch starts after this source ID, so that a restart continues there
const BackfillPayload = Schema.Struct({ after: Schema.NullOr(Schema.String) });

/**
 * Writes each source again, also sources without a bound recording, and resolves their merge
 * groups. This also runs a new title parser over old sources. Unchanged data writes nothing. Other
 * jobs run between batches.
 */
const runBackfill = Effect.fnUntraced(function* ({ after }: typeof BackfillPayload.Type) {
  const db = yield* Database;
  const jobs = yield* Jobs;
  const identity = yield* ReplicaDatabase;

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
  // raw fields of `source` and the uploader from the earlier parse remain.
  yield* Effect.forEach(
    rows,
    (row) =>
      Effect.gen(function* () {
        const cached = Schema.decodeUnknownOption(ProviderSource)(row.cached);
        if (row.source.provider !== "local" && Option.isSome(cached)) {
          return yield* writeProviderSource(row.source.provider, cached.value);
        }

        const local = row.source.provider === "local";
        const boundId = yield* boundRecordingId(row.source.provider, row.source.externalId);
        // Without the file or the provider cache, the raw columns would replace the values of the
        // server replica that wrote the source with nulls. That replica writes it again.
        if (row.tags === null) {
          const ownId = yield* assertionId({
            entityType: "recording",
            entityId: boundId,
            field: "title",
            origin: local ? "local" : "provider",
            originRef: local ? row.source.id : `${row.source.provider}:${row.source.externalId}`,
          });
          const [own] = yield* db
            .select({ author: catalogAssertion.authorReplicaId })
            .from(catalogAssertion)
            .where(eq(catalogAssertion.id, ownId));
          if (own !== undefined && own.author !== identity.replicaId) return;
        }

        const tags = Option.getOrElse(Schema.decodeUnknownOption(Tags)(row.tags), () => ({}));
        const {
          id: _id,
          sourceId: _sourceId,
          hlc: _hlc,
          changeSeq: _seq,
          ...variant
        } = row.variant;
        const parseId = yield* assertionId({
          entityType: "recording",
          entityId: boundId,
          field: "title",
          origin: "parse",
          originRef: `${row.source.provider}:${row.source.externalId}`,
        });
        const [parse] = yield* db
          .select({ evidence: catalogAssertion.evidence })
          .from(catalogAssertion)
          .where(eq(catalogAssertion.id, parseId));
        const evidence = Schema.decodeUnknownOption(ParseEvidence)(parse?.evidence);
        return yield* writeSource(
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
            uploader: Option.isSome(evidence) ? evidence.value.uploader : null,
            albumType: tagAlbumType(tags),
            releaseDate: tagReleaseDate(tags),
          },
          variant,
        );
      }),
    { discard: true },
  );

  // Merge rows can also come from an admin, outside of `writeSource`
  const boundIds = yield* Effect.forEach(rows, (row) =>
    boundRecordingId(row.source.provider, row.source.externalId),
  );
  const affected = yield* resolveRoots(boundIds);
  yield* projectRecordings(affected);
  // Writers decide artist merges; a batch also catches merges that arrived from peers
  yield* matchArtistsOf(affected);
  yield* assertSegmentMatches(rows.map((row) => row.source.id));

  const last = rows.at(-1);
  if (rows.length < batchSize || last === undefined) {
    // Recordings without a source, for example of matched tracklist entries, are in no batch
    yield* projectRecordings(yield* uncreditedRecordings);
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
  copyDiscoveryLayer,
  editionsLayer,
  artistLinksLayer,
  Layer.effectDiscard(
    Effect.gen(function* () {
      const db = yield* Database;
      const jobs = yield* Jobs;

      yield* jobs.register(backfillKind, BackfillPayload, runBackfill, { homeOnly: true });

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
