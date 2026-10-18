import { recording, source, sourceSegment } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, HeardInSet, SourceSummary } from "@dyad/domain";
import { asc, eq, inArray, or } from "drizzle-orm";
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
