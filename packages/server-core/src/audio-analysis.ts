// @effect-diagnostics-next-line nodeBuiltinImport:off -- FFmpeg reads cached bytes from a Node stream
import { Readable } from "node:stream";

import { audioAnalysis, libraryRoot, localFile, sourceVariant } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { AudioAnalysis } from "@dyad/domain";
import { BeatAnalysis, MediaStream, measureAudio } from "@dyad/media/node";
import { BeatGrid, Camelot, DjAnalysis } from "@dyad/player";
import { and, eq, inArray, isNull, ne, notInArray, or } from "drizzle-orm";
import { Clock, Data, Effect, Layer, Option, Path, Redacted, Schema, Stream } from "effect";
import type { Scope } from "effect";

import { Jobs } from "./jobs.ts";
import { MediaCache } from "./media-cache.ts";
import type { CachedAudio } from "./media-cache.ts";

const analysisKind = "audio.analyze";

// Raise it when the measurement changes, so that every row is analyzed again
const analyzerVersion = 2;

/** Asks for the analysis of audio without one, for example after a library scan */
export const requestAnalysis = Effect.gen(function* () {
  const jobs = yield* Jobs;
  yield* jobs.enqueue(analysisKind, analysisKind, {}, { priority: -1 });
});

/** The analysis of the source's audio, or `null` before the first analysis */
export const sourceAnalysis = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({
        loudness: audioAnalysis.loudness,
        truePeak: audioAnalysis.truePeak,
        leadingSilenceMs: audioAnalysis.leadingSilenceMs,
        trailingSilenceMs: audioAnalysis.trailingSilenceMs,
      })
      .from(audioAnalysis)
      .innerJoin(sourceVariant, eq(sourceVariant.id, audioAnalysis.variantId))
      .where(eq(sourceVariant.sourceId, sourceId))
      .limit(1);
    return row === undefined ? null : new AudioAnalysis(row);
  });

/** The beat analysis of the source's audio, or `undefined` before the first analysis */
export const sourceDjAnalysis = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ beats: audioAnalysis.beats })
      .from(audioAnalysis)
      .innerJoin(sourceVariant, eq(sourceVariant.id, audioAnalysis.variantId))
      .where(eq(sourceVariant.sourceId, sourceId))
      .limit(1);
    if (row === undefined || row.beats === null) return undefined;
    const beats = yield* Schema.decodeUnknownEffect(BeatAnalysis)(row.beats).pipe(Effect.orDie);
    return new DjAnalysis({
      ...beats,
      intro: new BeatGrid(beats.intro),
      outro: new BeatGrid(beats.outro),
      key: beats.key === null ? undefined : new Camelot(beats.key),
    });
  });

class Target extends Data.Class<{
  readonly variantId: string;
  readonly asset: string;
  readonly media: Effect.Effect<string | MediaStream, never, Scope.Scope>;
}> {}

const assetOf = (file: CachedAudio) => file.keyIds.join("-");

/**
 * Analyzes one variant per job run: cached files first, newest first, then local files. Encrypted
 * files wait until playback gives their keys.
 */
export const audioAnalysisLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;
    const cache = yield* MediaCache;
    const path = yield* Path.Path;
    // By variant ID, until the analysis of the file
    const keys = new Map<string, Redacted.Redacted<ReadonlyMap<string, string>>>();
    // Variants that did not decode since the start
    const failed = new Set<string>();

    const cachedMedia = (file: CachedAudio, container: string) =>
      Effect.gen(function* () {
        // `node-av` 6.1.1 does not close a `Readable` input
        const bytes = yield* Effect.acquireRelease(
          Effect.sync(() => Readable.fromWeb(Stream.toReadableStream(cache.read(file)))),
          (bytes) => Effect.sync(() => bytes.destroy()),
        );
        // FFmpeg's `decryption_keys` dictionary is `<kid>=<key>` pairs, separated by `:`
        const fileKeys = keys.get(file.variantId);
        const options =
          fileKeys === undefined
            ? {}
            : {
                decryption_keys: Redacted.make(
                  [...Redacted.value(fileKeys)].map(([kid, key]) => `${kid}=${key}`).join(":"),
                ),
              };
        return new MediaStream({ name: file.variantId, bytes, format: container, options });
      });

    const nextTarget = Effect.gen(function* () {
      const files = yield* cache.list;
      const variants = new Map(
        (yield* db
          .select({
            id: sourceVariant.id,
            container: sourceVariant.container,
            asset: audioAnalysis.asset,
            version: audioAnalysis.analyzerVersion,
          })
          .from(sourceVariant)
          .leftJoin(audioAnalysis, eq(audioAnalysis.variantId, sourceVariant.id))
          .where(
            inArray(
              sourceVariant.id,
              files.map((file) => file.variantId),
            ),
          )).map((row) => [row.id, row] as const),
      );
      const cached = files
        .toSorted((a, b) => b.modifiedAt - a.modifiedAt)
        .flatMap((file) => {
          const variant = variants.get(file.variantId);
          if (variant === undefined || failed.has(file.variantId)) return [];
          if (variant.version === analyzerVersion && variant.asset === assetOf(file)) return [];
          if (file.keyIds.length > 0 && !keys.has(file.variantId)) return [];
          return [
            new Target({
              variantId: file.variantId,
              asset: assetOf(file),
              media: cachedMedia(file, variant.container),
            }),
          ];
        });
      if (cached[0] !== undefined) return cached[0];

      const [local] = yield* db
        .select({ variantId: sourceVariant.id, root: libraryRoot.path, file: localFile.path })
        .from(localFile)
        .innerJoin(libraryRoot, eq(libraryRoot.id, localFile.libraryRootId))
        .innerJoin(sourceVariant, eq(sourceVariant.sourceId, localFile.sourceId))
        .leftJoin(audioAnalysis, eq(audioAnalysis.variantId, sourceVariant.id))
        .where(
          and(
            or(
              isNull(audioAnalysis.analyzerVersion),
              ne(audioAnalysis.analyzerVersion, analyzerVersion),
            ),
            notInArray(sourceVariant.id, [...failed]),
          ),
        )
        .limit(1);
      if (local === undefined) return undefined;
      return new Target({
        variantId: local.variantId,
        asset: "",
        media: Effect.succeed(path.join(local.root, local.file)),
      });
    });

    const analyzeNext = Effect.gen(function* () {
      const target = yield* nextTarget;
      if (target === undefined) return;

      const startedAt = yield* Clock.currentTimeMillis;
      const measured = yield* Effect.scoped(Effect.flatMap(target.media, measureAudio)).pipe(
        Effect.tapError((error) =>
          Effect.logWarning("Cannot analyze audio").pipe(
            Effect.annotateLogs({ variantId: target.variantId, reason: error.reason }),
          ),
        ),
        Effect.option,
      );
      keys.delete(target.variantId);
      const finishedAt = yield* Clock.currentTimeMillis;

      if (Option.isNone(measured)) {
        failed.add(target.variantId);
      } else {
        const { beats } = measured.value;
        const row = {
          asset: target.asset,
          analyzerVersion,
          loudness: measured.value.loudness,
          truePeak: measured.value.truePeak,
          leadingSilenceMs: measured.value.leadingSilenceMs,
          trailingSilenceMs: measured.value.trailingSilenceMs,
          beats:
            beats === undefined
              ? null
              : yield* Schema.encodeEffect(BeatAnalysis)(beats).pipe(Effect.orDie),
          analyzedAt: finishedAt,
        };
        yield* db
          .insert(audioAnalysis)
          .values({ variantId: target.variantId, ...row })
          .onConflictDoUpdate({ target: audioAnalysis.variantId, set: row });
      }

      // The pause is as long as the analysis, so that analysis uses at most half of one core
      yield* jobs.enqueue(
        analysisKind,
        analysisKind,
        {},
        { priority: -1, runAt: finishedAt + (finishedAt - startedAt) },
      );
    });

    yield* jobs.register(analysisKind, Schema.Struct({}), () => analyzeNext);

    yield* Stream.fromPubSub(cache.ready).pipe(
      Stream.runForEach((ready) =>
        Effect.gen(function* () {
          const [row] = yield* db
            .select({ asset: audioAnalysis.asset, version: audioAnalysis.analyzerVersion })
            .from(audioAnalysis)
            .where(eq(audioAnalysis.variantId, ready.file.variantId));
          if (row?.version === analyzerVersion && row.asset === assetOf(ready.file)) return;

          if (ready.decryptionKeys !== undefined) {
            keys.set(ready.file.variantId, ready.decryptionKeys);
          }
          failed.delete(ready.file.variantId);
          yield* requestAnalysis;
        }).pipe(Effect.catch((error) => Effect.logWarning("Cannot request audio analysis", error))),
      ),
      Effect.forkScoped,
    );

    yield* requestAnalysis;
  }),
);
