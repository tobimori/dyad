import { entityMerge, isrcLookup, job, recording, user } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, MergeFailed } from "@dyad/domain";
import type { MusicBrainzLookup, MusicBrainzRecording } from "@dyad/plugin";
import { HlcClock } from "@dyad/sync";
import { and, asc, eq, inArray, lt, ne } from "drizzle-orm";
import { Clock, Context, Data, Effect, Layer, Option, Schema } from "effect";

import { artistLinksKind } from "./artist-links.ts";
import { matchArtistsOf } from "./artist-matching.ts";
import { assertRecording, fields, projectRecordings, resolvedValues } from "./assertions.ts";
import { isrcRecordingId, mergeId, musicbrainzRecordingId } from "./ids.ts";
import { Jobs, RetryLater } from "./jobs.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";

/** The MusicBrainz lookups that a plugin supplies. One plugin at most. */
export class MusicBrainzLookups extends Context.Service<
  MusicBrainzLookups,
  Map<string, MusicBrainzLookup>
>()("@dyad/server-core/MusicBrainzLookups") {}

export const musicbrainzLookupsLayer = Layer.sync(MusicBrainzLookups, () => new Map());

export const musicbrainzLookupKey = "musicbrainz";

// Encoder padding, fades and remasters move the duration of one recording by a few seconds. Other
// edits that share an ISRC by mistake differ by more.
const durationToleranceMs = 3000;
const durationToleranceShare = 0.02;

const lookupKind = "matching.isrc";
export const tracklistMatchKind = "tracklist.match";
// One MusicBrainz search finds 25 ISRCs
const lookupBatchSize = 25;
// MusicBrainz grows, so an ISRC without a match gets another chance
const lookupLifetimeMs = 90 * 24 * 60 * 60 * 1000;
// MusicBrainz can answer 503 with `Retry-After: 0` when the whole server is busy (October 2026)
const busyWaitSeconds = 60;

const IsrcEvidence = Schema.Struct({ isrc: Schema.String });

class Edge extends Data.Class<{
  readonly fromId: string;
  readonly intoId: string;
  readonly intoOrigin: "isrc" | "musicbrainz";
  readonly decision: "merge" | "reject";
  readonly method: "mbid_tag" | "isrc";
  readonly confidence: number;
  readonly evidence: Readonly<Record<string, string>>;
}> {}

/**
 * Writes the `system` row of the pair only when the decision changes. Returns whether it changed. A
 * reject row keeps the entity a candidate, so that the decision does not depend on arrival order.
 */
export const writeSystemMerge = (edge: {
  readonly entityType: "recording" | "artist";
  readonly fromId: string;
  readonly intoId: string;
  readonly decision: "merge" | "reject";
  readonly method: typeof entityMerge.$inferInsert.method;
  readonly confidence: number;
  readonly evidence: Readonly<Record<string, string>>;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const id = yield* mergeId({ ...edge, origin: "system" });

    const [row] = yield* db.select().from(entityMerge).where(eq(entityMerge.id, id));
    if (row?.decision === edge.decision && row.confidence === edge.confidence) return false;

    const values = {
      id,
      ...edge,
      origin: "system" as const,
      authorUserId: null,
      hlc: yield* clock.next,
    };
    yield* db.transaction(() =>
      Effect.gen(function* () {
        const row = { ...values, changeSeq: yield* nextChangeSeq };
        yield* db
          .insert(entityMerge)
          .values(row)
          .onConflictDoUpdate({ target: entityMerge.id, set: row });
      }),
    );
    return true;
  });

const writeEdge = (edge: Edge) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const { intoOrigin, ...merge } = edge;
    const changed = yield* writeSystemMerge({ entityType: "recording", ...merge });

    // A recording exists when an edge points to it
    if (changed && edge.decision === "merge") {
      yield* db
        .insert(recording)
        .values({ id: edge.intoId, origin: intoOrigin, policyVersion: 1, revision: 0 })
        .onConflictDoNothing();
    }
    return changed;
  });

const fitsDuration = (durationMs: number | null | undefined, referenceMs: number | null) =>
  durationMs === null ||
  durationMs === undefined ||
  referenceMs === null ||
  Math.abs(durationMs - referenceMs) <=
    Math.max(durationToleranceMs, referenceMs * durationToleranceShare);

const queueLookup = (isrc: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;
    const lookups = yield* MusicBrainzLookups;
    if (!lookups.has(musicbrainzLookupKey)) return;

    const now = yield* Clock.currentTimeMillis;
    const [lookup] = yield* db
      .select({ checkedAt: isrcLookup.checkedAt })
      .from(isrcLookup)
      .where(eq(isrcLookup.isrc, isrc));
    if (lookup !== undefined && now - lookup.checkedAt < lookupLifetimeMs) return;

    const [waiting] = yield* db
      .select({ key: job.key })
      .from(job)
      .where(and(eq(job.kind, lookupKind), eq(job.key, isrc)));
    if (waiting !== undefined) return;

    // After library imports and the backfill, which need no network
    yield* jobs.enqueue(lookupKind, isrc, { isrc }, { priority: -2 });
  });

/**
 * Merges the ISRC recording into the MusicBrainz recording only when MusicBrainz has exactly
 * one recording with the ISRC and its duration fits.
 */
const applyLookup = (isrc: string, referenceMs: number | null) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const isrcRecording = yield* isrcRecordingId(isrc);

    const [lookup] = yield* db.select().from(isrcLookup).where(eq(isrcLookup.isrc, isrc));
    if (lookup === undefined) return [];

    const [only, ...others] = lookup.recordings;
    const accepted =
      only !== undefined && others.length === 0 && fitsDuration(only.durationMs, referenceMs)
        ? only
        : undefined;
    const target = accepted === undefined ? null : yield* musicbrainzRecordingId(accepted.mbid);

    const earlier = yield* db
      .select({ intoId: entityMerge.intoId })
      .from(entityMerge)
      .where(
        and(
          eq(entityMerge.fromId, isrcRecording),
          eq(entityMerge.origin, "system"),
          eq(entityMerge.decision, "merge"),
        ),
      );
    const rejected = yield* Effect.forEach(
      earlier.filter((row) => row.intoId !== target),
      (row) =>
        writeEdge(
          new Edge({
            fromId: isrcRecording,
            intoId: row.intoId,
            intoOrigin: "musicbrainz",
            decision: "reject",
            method: "isrc",
            confidence: 0.95,
            evidence: { isrc },
          }),
        ),
    );

    const merged =
      target === null || accepted === undefined
        ? false
        : yield* writeEdge(
            new Edge({
              fromId: isrcRecording,
              intoId: target,
              intoOrigin: "musicbrainz",
              decision: "merge",
              method: "isrc",
              confidence: 0.95,
              evidence: { isrc, mbid: accepted.mbid },
            }),
          );

    return merged || rejected.includes(true) ? [isrcRecording] : [];
  });

/**
 * Recordings of the ISRC merge when their duration fits the median. Two edits that share an
 * ISRC by mistake stay apart.
 */
const matchIsrc = (isrc: string, newMember: string | null) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const isrcRecording = yield* isrcRecordingId(isrc);

    const rows = yield* db
      .select({ fromId: entityMerge.fromId })
      .from(entityMerge)
      .where(
        and(
          eq(entityMerge.entityType, "recording"),
          eq(entityMerge.intoId, isrcRecording),
          eq(entityMerge.origin, "system"),
        ),
      );
    const candidates = [
      ...new Set([...rows.map((row) => row.fromId), ...(newMember === null ? [] : [newMember])]),
    ];
    const isrcs = yield* resolvedValues(candidates, "isrc", fields.isrc);
    const durations = yield* resolvedValues(candidates, "duration_ms", fields.duration_ms);

    const members = candidates.filter((id) => isrcs.get(id) === isrc);
    const known = members.flatMap((id) => durations.get(id) ?? []).toSorted((a, b) => a - b);
    const referenceMs = known[Math.floor((known.length - 1) / 2)] ?? null;

    const changed = yield* Effect.filter(candidates, (id) =>
      writeEdge(
        new Edge({
          fromId: id,
          intoId: isrcRecording,
          intoOrigin: "isrc",
          decision:
            members.includes(id) && fitsDuration(durations.get(id), referenceMs)
              ? "merge"
              : "reject",
          method: "isrc",
          confidence: 0.9,
          evidence: { isrc },
        }),
      ),
    );

    yield* queueLookup(isrc);
    return [...changed, ...(yield* applyLookup(isrc, referenceMs))];
  });

/**
 * Writes the MBID tag and ISRC matches of a recording. Matches that its metadata no longer
 * supports become rejects.
 */
const matchRecording = (recordingId: string, mbid: string | null) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const isrc =
      (yield* resolvedValues([recordingId], "isrc", fields.isrc)).get(recordingId) ?? null;
    const mbidTarget = mbid === null ? null : yield* musicbrainzRecordingId(mbid);

    const earlier = yield* db
      .select()
      .from(entityMerge)
      .where(
        and(
          eq(entityMerge.entityType, "recording"),
          eq(entityMerge.fromId, recordingId),
          eq(entityMerge.origin, "system"),
          eq(entityMerge.decision, "merge"),
        ),
      );

    const staleTags = yield* Effect.filter(
      earlier.filter((row) => row.method === "mbid_tag" && row.intoId !== mbidTarget),
      (row) =>
        writeEdge(
          new Edge({
            fromId: recordingId,
            intoId: row.intoId,
            intoOrigin: "musicbrainz",
            decision: "reject",
            method: "mbid_tag",
            confidence: 1,
            evidence: {},
          }),
        ),
    );
    const staleIsrcs = earlier.flatMap((row) => {
      if (row.method !== "isrc") return [];

      const evidence = Schema.decodeUnknownOption(IsrcEvidence)(row.evidence);
      return Option.isSome(evidence) && evidence.value.isrc !== isrc ? [evidence.value.isrc] : [];
    });
    const regrouped = yield* Effect.forEach(staleIsrcs, (stale) => matchIsrc(stale, null));

    const tagged =
      mbidTarget === null
        ? false
        : yield* writeEdge(
            new Edge({
              fromId: recordingId,
              intoId: mbidTarget,
              intoOrigin: "musicbrainz",
              decision: "merge",
              method: "mbid_tag",
              confidence: 1,
              evidence: { mbid: mbid ?? "" },
            }),
          );
    const grouped = isrc === null ? [] : yield* matchIsrc(isrc, recordingId);

    return [
      ...staleTags.map((row) => row.fromId),
      ...regrouped.flat(),
      ...(tagged ? [recordingId] : []),
      ...grouped,
    ];
  });

/**
 * Identity of recordings and artists: an `admin` row on an entity freezes its `system` rows. Then
 * the highest confidence, the newest HLC and the lowest target win.
 */
export const effectiveTarget = (rows: ReadonlyArray<typeof entityMerge.$inferSelect>) => {
  const admin = rows.some((row) => row.origin === "admin");
  const [edge] = rows
    .filter((row) => (!admin || row.origin === "admin") && row.decision === "merge")
    .toSorted(
      (a, b) =>
        b.confidence - a.confidence ||
        b.hlc.localeCompare(a.hlc) ||
        a.intoId.localeCompare(b.intoId),
    );
  return edge?.intoId ?? null;
};

/** The end of the effective edges from an entity. In a cycle, the lowest ID is the root. */
export const followEdges =
  <E, R>(targetOf: (id: string) => Effect.Effect<string | null, E, R>) =>
  (id: string) =>
    Effect.gen(function* () {
      const path = [id];
      while (true) {
        const next = yield* targetOf(path.at(-1) ?? id);
        if (next === null) return path.at(-1) ?? id;
        if (path.includes(next)) return path.slice(path.indexOf(next)).toSorted()[0] ?? next;
        path.push(next);
      }
    });

/**
 * Updates `merged_into_id` and `status` of the recordings whose root can change with the edges
 * of `recordingIds`
 */
export const resolveRoots = (recordingIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const start = [...new Set(recordingIds)];

    // A changed edge moves the recording and everything in its earlier group
    const current = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, start));
    const seeds = [...new Set([...start, ...current.flatMap((row) => row.mergedIntoId ?? [])])];
    const members = yield* db
      .select({ id: recording.id })
      .from(recording)
      .where(inArray(recording.mergedIntoId, seeds));
    const affected = [...new Set([...seeds, ...members.map((row) => row.id)])];

    const targets = new Map<string, string | null>();
    const targetOf = (id: string) =>
      Effect.gen(function* () {
        const known = targets.get(id);
        if (known !== undefined) return known;

        const rows = yield* db
          .select()
          .from(entityMerge)
          .where(and(eq(entityMerge.entityType, "recording"), eq(entityMerge.fromId, id)));
        const target = effectiveTarget(rows);
        targets.set(id, target);
        return target;
      });

    const rootOf = followEdges(targetOf);

    const rows = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId, status: recording.status })
      .from(recording)
      .where(inArray(recording.id, affected));
    const resolved = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const root = yield* rootOf(row.id);
        const mergedIntoId = root === row.id ? null : root;
        const status = mergedIntoId === null ? "active" : "merged";

        const moved = row.mergedIntoId !== mergedIntoId || row.status !== status;
        if (moved) {
          yield* db.update(recording).set({ mergedIntoId, status }).where(eq(recording.id, row.id));
        }
        return { root, moved: moved ? [row.id, row.mergedIntoId ?? row.id] : [] };
      }),
    );

    // The earlier and the new group of a moved recording change
    yield* touchGroups(resolved.flatMap((result) => result.moved));
    return new Set([...affected, ...resolved.map((result) => result.root)]);
  });

/**
 * Matches a bound recording after its assertions changed, and updates the canonical rows of its
 * group. Run it in the transaction of the assertions.
 */
export const updateRecording = (recordingId: string, mbid: string | null) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const changed = yield* matchRecording(recordingId, mbid);
    const affected =
      changed.length === 0 ? new Set<string>() : yield* resolveRoots([recordingId, ...changed]);

    const [row] = yield* db
      .select({ mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(eq(recording.id, recordingId));
    const projected = [...affected, recordingId, row?.mergedIntoId ?? recordingId];
    yield* projectRecordings(projected);
    yield* matchArtistsOf(projected);
  });

/**
 * Writes the `admin` row of the pair and resolves the groups at once. An `admin` row freezes the
 * `system` rows of `fromId`, so a `reject` takes it out of any group.
 */
export const decideMerge = (
  pair: { readonly fromId: string; readonly intoId: string },
  decision: "merge" | "reject",
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const principal = yield* CurrentPrincipal;

    const [author] = yield* db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, principal.userId));
    if (author?.role !== "admin") return yield* new MergeFailed({ reason: "not_admin" });
    if (pair.fromId === pair.intoId) return yield* new MergeFailed({ reason: "same_recording" });

    const found = yield* db
      .select({ id: recording.id })
      .from(recording)
      .where(inArray(recording.id, [pair.fromId, pair.intoId]));
    if (found.length < 2) return yield* new MergeFailed({ reason: "recording_not_found" });

    const values = {
      id: yield* mergeId({ entityType: "recording", ...pair, origin: "admin" }),
      entityType: "recording" as const,
      ...pair,
      decision,
      origin: "admin" as const,
      method: "manual" as const,
      confidence: 1,
      evidence: null,
      authorUserId: principal.userId,
      hlc: yield* clock.next,
    };
    yield* db.transaction(() =>
      Effect.gen(function* () {
        const row = { ...values, changeSeq: yield* nextChangeSeq };
        yield* db
          .insert(entityMerge)
          .values(row)
          .onConflictDoUpdate({ target: entityMerge.id, set: row });
        const affected = yield* resolveRoots([pair.fromId]);
        yield* projectRecordings(affected);
        yield* matchArtistsOf(affected);
      }),
    );
  });

/** Asserts the fields of a MusicBrainz recording and returns its ID */
export const assertMusicBrainzRecording = (item: MusicBrainzRecording) =>
  Effect.gen(function* () {
    const id = yield* musicbrainzRecordingId(item.mbid);
    yield* assertRecording(id, "musicbrainz", item.mbid, {
      title: item.title,
      artist_credit:
        item.artist === null
          ? null
          : {
              name: item.artist,
              artists: item.artists.map((artist) => ({ id: artist.id, name: artist.name })),
            },
      album: null,
      duration_ms: item.durationMs,
      isrc: null,
      artwork_url: null,
      explicit: null,
    });
    return id;
  });

/**
 * Delays all jobs that ask MusicBrainz, because the limit is per IP. Returns the wait in seconds.
 */
export const waitForMusicBrainz = (retryAfterSeconds: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const waitSeconds = Math.max(retryAfterSeconds, busyWaitSeconds);
    const runAt = (yield* Clock.currentTimeMillis) + waitSeconds * 1000;
    yield* db
      .update(job)
      .set({ nextRunAt: runAt })
      .where(
        and(
          inArray(job.kind, [lookupKind, tracklistMatchKind, artistLinksKind]),
          lt(job.nextRunAt, runAt),
        ),
      );
    return waitSeconds;
  });

const LookupPayload = Schema.Struct({ isrc: Schema.String });

const writeLookup = (isrc: string, recordings: ReadonlyArray<MusicBrainzRecording>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const checkedAt = yield* Clock.currentTimeMillis;
    const row = {
      isrc,
      recordings: recordings.map((item) => ({ mbid: item.mbid, durationMs: item.durationMs })),
      checkedAt,
    };
    yield* db
      .insert(isrcLookup)
      .values(row)
      .onConflictDoUpdate({ target: isrcLookup.isrc, set: row });

    const [only, ...others] = recordings;
    // Only an unambiguous recording gets assertions
    const assertedIds = yield* Effect.forEach(
      only === undefined || others.length > 0 ? [] : [only],
      assertMusicBrainzRecording,
    );

    const changed = yield* matchIsrc(isrc, null);
    const affected = changed.length === 0 ? [] : yield* resolveRoots(changed);
    yield* projectRecordings([...affected, ...assertedIds]);
    yield* matchArtistsOf([...affected, ...assertedIds]);
  });

// ISRCs that wait share the request of this job
const runLookup = ({ isrc }: typeof LookupPayload.Type) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;
    const lookup = (yield* MusicBrainzLookups).get(musicbrainzLookupKey);
    // The plugin failed to start; the job waits for the next start
    if (lookup === undefined) return yield* new RetryLater({ retryAfterSeconds: 60 * 60 });

    const waiting = yield* db
      .select({ key: job.key })
      .from(job)
      .where(and(eq(job.kind, lookupKind), ne(job.key, isrc)))
      .orderBy(asc(job.nextRunAt))
      .limit(lookupBatchSize - 1);
    const isrcs = [isrc, ...waiting.map((row) => row.key)];

    const results = yield* lookup.recordingsByIsrc(isrcs).pipe(
      Effect.catchIf(
        (error) => error.retryAfterSeconds !== null,
        (error) =>
          Effect.gen(function* () {
            const retryAfterSeconds = yield* waitForMusicBrainz(error.retryAfterSeconds ?? 0);
            return yield* new RetryLater({ retryAfterSeconds });
          }),
      ),
    );

    yield* db.transaction(() =>
      Effect.forEach(isrcs, (item) => writeLookup(item, results.get(item) ?? []), {
        discard: true,
      }),
    );
    yield* Effect.forEach(waiting, (row) => jobs.cancel(lookupKind, row.key), { discard: true });

    yield* Effect.logInfo("ISRCs looked up").pipe(
      Effect.annotateLogs({
        isrcs: isrcs.length,
        matched: isrcs.filter((item) => results.get(item)?.length === 1).length,
      }),
    );
  });

export const matchingLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    yield* jobs.register(lookupKind, LookupPayload, runLookup, { homeOnly: true });
  }),
);
