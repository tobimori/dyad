import { libraryItem, playEvent, recording, source, sourceSegment } from "@dyad/db/client";
import { HeardInSet, RecordingId } from "@dyad/domain";
import type { SourceSummary } from "@dyad/domain";
import { asc, eq, inArray, max, or } from "drizzle-orm";
import { Data, Effect } from "effect";

import { ClientDatabase } from "./database.ts";
import { playableSources } from "./views.ts";

/** A DJ set with a tracklist that the user played or saved */
export class LocalSet extends Data.Class<{
  readonly source: SourceSummary;
  readonly tracks: number;
  /** The matched recordings in tracklist order, each once */
  readonly identified: ReadonlyArray<RecordingId>;
  readonly lastPlayedAt: number | null;
}> {}

/** The last played first. Copies of one recording on several providers give one set. */
export const localSets = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  const segments = yield* db
    .select({ sourceId: sourceSegment.sourceId, recordingId: sourceSegment.recordingId })
    .from(sourceSegment)
    .orderBy(asc(sourceSegment.sourceId), asc(sourceSegment.position));
  const setIds = [...new Set(segments.map((segment) => segment.sourceId))];
  if (setIds.length === 0) return [];

  const plays = yield* db
    .select({ sourceId: playEvent.sourceId, lastPlayedAt: max(playEvent.startedAt) })
    .from(playEvent)
    .where(inArray(playEvent.sourceId, setIds))
    .groupBy(playEvent.sourceId);
  const playedAt = new Map(plays.map((play) => [play.sourceId, play.lastPlayedAt]));

  const saved = yield* db
    .select({ recordingId: libraryItem.entityId })
    .from(libraryItem)
    .where(eq(libraryItem.deleted, false));
  const bound = yield* db
    .select({ id: source.id, recordingId: source.recordingId })
    .from(source)
    .where(inArray(source.id, setIds));
  const recordings = yield* db
    .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
    .from(recording)
    .where(
      inArray(recording.id, [
        ...saved.map((item) => item.recordingId),
        ...bound.flatMap((row) => row.recordingId ?? []),
      ]),
    );
  const roots = new Map(recordings.map((row) => [row.id, row.mergedIntoId ?? row.id]));
  const rootOf = (id: string) => roots.get(id) ?? id;
  const savedRoots = new Set(saved.map((item) => rootOf(item.recordingId)));
  const setRoot = new Map(bound.map((row) => [row.id, rootOf(row.recordingId ?? row.id)]));

  const wanted = setIds.filter((id) => playedAt.has(id) || savedRoots.has(setRoot.get(id) ?? id));
  const playable = yield* playableSources(inArray(source.id, wanted));

  const sets = playable
    .map(({ summary }) => {
      const own = segments.filter((segment) => segment.sourceId === summary.id);
      const identified = [...new Set(own.flatMap((segment) => segment.recordingId ?? []))];
      return new LocalSet({
        source: summary,
        tracks: own.length,
        identified: identified.map((id) => RecordingId.make(id)),
        lastPlayedAt: playedAt.get(summary.id) ?? null,
      });
    })
    .toSorted(
      (a, b) =>
        (b.lastPlayedAt ?? 0) - (a.lastPlayedAt ?? 0) ||
        (a.source.title ?? "").localeCompare(b.source.title ?? ""),
    );
  // The played copy, else the first, stands for its recording
  const seen = new Set<string>();
  return sets.filter((set) => {
    const root = setRoot.get(set.source.id) ?? set.source.id;
    if (seen.has(root)) return false;
    seen.add(root);
    return true;
  });
}).pipe(Effect.orDie);

/** Like `heardInSets` of the server, for the sets on the replica */
export const localHeardInSets = (recordingId: string) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const [bound] = yield* db
      .select({ mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(eq(recording.id, recordingId));
    const root = bound?.mergedIntoId ?? recordingId;
    const group = yield* db
      .select({ id: recording.id })
      .from(recording)
      .where(or(eq(recording.id, root), eq(recording.mergedIntoId, root)));
    const segments = yield* db
      .select({ sourceId: sourceSegment.sourceId, startMs: sourceSegment.startMs })
      .from(sourceSegment)
      .where(inArray(sourceSegment.recordingId, [recordingId, ...group.map((row) => row.id)]))
      .orderBy(asc(sourceSegment.position));
    const starts = new Map<string, number | null>();
    for (const segment of segments) {
      if (!starts.has(segment.sourceId)) starts.set(segment.sourceId, segment.startMs);
    }

    const sets = yield* playableSources(inArray(source.id, [...starts.keys()]));
    return sets
      .map(
        ({ summary }) => new HeardInSet({ set: summary, startMs: starts.get(summary.id) ?? null }),
      )
      .toSorted((a, b) => (a.set.title ?? "").localeCompare(b.set.title ?? ""));
  }).pipe(Effect.orDie);
