import { libraryItem, playEvent, recording, source, sourceSegment } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, HeardInSet, RecordingId, SetSummary, SourceSummary } from "@dyad/domain";
import { and, asc, eq, inArray, max, or } from "drizzle-orm";
import { Effect } from "effect";

import { fields, resolvedValues } from "./assertions.ts";
import { playableSources, sourceSummary } from "./sources.ts";

/** The recording, its root and the other recordings merged into the root */
export const recordingGroup = (recordingId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [bound] = yield* db
      .select({ mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(eq(recording.id, recordingId));
    const root = bound?.mergedIntoId ?? recordingId;
    const members = yield* db
      .select({ id: recording.id })
      .from(recording)
      .where(or(eq(recording.id, root), eq(recording.mergedIntoId, root)));
    return [...new Set([recordingId, ...members.map((row) => row.id)])];
  });

/** Adds the series that the title parse found for the recording of each source */
export const withSeries = (summaries: ReadonlyArray<SourceSummary>) =>
  Effect.gen(function* () {
    const recordingIds = [...new Set(summaries.flatMap((summary) => summary.recordingId ?? []))];
    if (recordingIds.length === 0) return summaries;
    const series = yield* resolvedValues(recordingIds, "series", fields.series);
    return summaries.map((summary) => {
      const name = series.get(summary.recordingId ?? "")?.name ?? null;
      return name === null ? summary : new SourceSummary({ ...summary, series: name });
    });
  });

/** Each set that the user can play, at the first time that it plays the recording */
export const heardInSets = (recordingId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    const segments = yield* db
      .select({ sourceId: sourceSegment.sourceId, startMs: sourceSegment.startMs })
      .from(sourceSegment)
      .where(inArray(sourceSegment.recordingId, yield* recordingGroup(recordingId)))
      .orderBy(asc(sourceSegment.position));
    const starts = new Map<string, number | null>();
    for (const segment of segments) {
      if (!starts.has(segment.sourceId)) starts.set(segment.sourceId, segment.startMs);
    }
    if (starts.size === 0) return [];

    const rows = yield* playableSources(principal.userId, inArray(source.id, [...starts.keys()]));
    const sets = yield* withSeries(rows.map(sourceSummary));
    return sets
      .map((set) => new HeardInSet({ set, startMs: starts.get(set.id) ?? null }))
      .toSorted((a, b) => (a.set.title ?? "").localeCompare(b.set.title ?? ""));
  });

/** The last played first. Copies of one recording on several providers give one set. */
export const listSets = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;
  const segments = yield* db
    .select({ sourceId: sourceSegment.sourceId, recordingId: sourceSegment.recordingId })
    .from(sourceSegment)
    .orderBy(asc(sourceSegment.sourceId), asc(sourceSegment.position));
  const setIds = [...new Set(segments.map((segment) => segment.sourceId))];
  if (setIds.length === 0) return [];

  const plays = yield* db
    .select({ sourceId: playEvent.sourceId, lastPlayedAt: max(playEvent.startedAt) })
    .from(playEvent)
    .where(and(eq(playEvent.userId, principal.userId), inArray(playEvent.sourceId, setIds)))
    .groupBy(playEvent.sourceId);
  const playedAt = new Map(plays.map((play) => [play.sourceId, play.lastPlayedAt]));

  const saved = yield* db
    .select({ recordingId: libraryItem.entityId })
    .from(libraryItem)
    .where(
      and(
        eq(libraryItem.userId, principal.userId),
        eq(libraryItem.deleted, false),
        eq(libraryItem.entityType, "recording"),
      ),
    );
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
  const rows = yield* playableSources(principal.userId, inArray(source.id, wanted));
  const sets = (yield* withSeries(rows.map(sourceSummary)))
    .map((summary) => {
      const own = segments.filter((segment) => segment.sourceId === summary.id);
      const identified = [...new Set(own.flatMap((segment) => segment.recordingId ?? []))];
      return new SetSummary({
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
});
