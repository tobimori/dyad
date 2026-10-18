import { catalogAssertion, recording, source, sourceSegment, user } from "@dyad/db";
import { Database, ReplicaDatabase } from "@dyad/db/node";
import { CurrentPrincipal, SourceSegment, TracklistEditFailed, UserId } from "@dyad/domain";
import { TracklistEntry } from "@dyad/plugin";
import type { MusicBrainzRecording, ProviderTracklist } from "@dyad/plugin";
import { HlcClock } from "@dyad/sync";
import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { Clock, Context, Effect, Layer, PubSub, Result, Schema, Stream } from "effect";

import { assertRecording, projectRecordings, resolveField } from "./assertions.ts";
import { assertionId, musicbrainzRecordingId } from "./ids.ts";
import { Jobs, RetryLater } from "./jobs.ts";
import { MusicBrainzLookups, musicbrainzLookupKey } from "./matching.ts";
import { normalizeArtist, normalizeText } from "./normalize.ts";
import { Providers, usableProviders } from "./providers.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { touchGroups } from "./sync-counter.ts";

const readKind = "tracklist.read";
const matchKind = "tracklist.match";
const field = "tracklist";
const Entries = Schema.Array(TracklistEntry);

// Descriptions and comments change, so a play reads the tracklists again after a day
const rereadAfterMs = 24 * 60 * 60 * 1000;
// MusicBrainz can answer 503 with `Retry-After: 0` when the whole server is busy (October 2026)
const busyWaitSeconds = 60;

const makeTracklists = Effect.gen(function* () {
  return {
    /** The IDs of sources whose segments changed */
    changes: yield* PubSub.unbounded<string>(),
    /** When this process last queued a read of each source */
    readAt: new Map<string, number>(),
  };
});

export class Tracklists extends Context.Service<
  Tracklists,
  Effect.Success<typeof makeTracklists>
>()("@dyad/server-core/Tracklists") {}

export const tracklistsServiceLayer = Layer.effect(Tracklists, makeTracklists);

const publish = (sourceId: string) =>
  Effect.gen(function* () {
    yield* PubSub.publish((yield* Tracklists).changes, sourceId);
  });

// An unchanged assertion writes nothing
const assertTracklist = (
  sourceId: string,
  assertion: {
    readonly origin: "provider" | "admin";
    readonly originRef: string;
    readonly value: typeof Entries.Encoded | null;
    readonly confidence: number;
    readonly authorUserId: UserId | null;
  },
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const identity = yield* ReplicaDatabase;
    const id = yield* assertionId({
      entityType: "source",
      entityId: sourceId,
      field,
      ...assertion,
    });

    const [known] = yield* db.select().from(catalogAssertion).where(eq(catalogAssertion.id, id));
    const same =
      known !== undefined &&
      !known.retracted &&
      JSON.stringify([known.value, known.confidence]) ===
        JSON.stringify([assertion.value, assertion.confidence]);
    if (same) return id;

    const row = {
      id,
      workspaceId: identity.workspaceId,
      entityType: "source",
      entityId: sourceId,
      field,
      ...assertion,
      originRevision: null,
      evidence: null,
      authorReplicaId: identity.replicaId,
      hlc: yield* (yield* HlcClock).next,
      retracted: false,
      schemaVersion: 1,
    };
    yield* db
      .insert(catalogAssertion)
      .values(row)
      .onConflictDoUpdate({ target: catalogAssertion.id, set: row });
    return id;
  });

const retract = (ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    if (ids.length === 0) return;
    const db = yield* Database;
    yield* db
      .update(catalogAssertion)
      .set({ retracted: true, hlc: yield* (yield* HlcClock).next })
      .where(inArray(catalogAssertion.id, [...ids]));
  });

const tracklistAssertions = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    return yield* db
      .select()
      .from(catalogAssertion)
      .where(
        and(
          eq(catalogAssertion.entityType, "source"),
          eq(catalogAssertion.entityId, sourceId),
          eq(catalogAssertion.field, field),
          eq(catalogAssertion.retracted, false),
        ),
      );
  });

// The candidates of `originRef` that a read no longer finds are withdrawn
const assertProviderTracklists = (
  sourceId: string,
  originRef: string,
  tracklists: ReadonlyArray<ProviderTracklist>,
) =>
  Effect.gen(function* () {
    const written = yield* Effect.forEach(tracklists, (tracklist) =>
      assertTracklist(sourceId, {
        origin: "provider",
        originRef: `${originRef}#${tracklist.part}`,
        value: Schema.encodeSync(Entries)(tracklist.entries),
        confidence: tracklist.confidence,
        authorUserId: null,
      }),
    );
    const lost = (yield* tracklistAssertions(sourceId)).filter(
      (assertion) =>
        assertion.origin === "provider" &&
        assertion.originRef.startsWith(`${originRef}#`) &&
        !written.includes(assertion.id),
    );
    yield* retract(lost.map((assertion) => assertion.id));
  });

const entryKey = (entry: { readonly artist: string | null; readonly title: string | null }) =>
  JSON.stringify([entry.artist, entry.title]);

/**
 * Makes the segments of the source from its selected tracklist. A segment keeps the recording of an
 * earlier segment with the same text, also of another source. Returns whether a segment changed.
 */
const deriveSegments = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db.select().from(source).where(eq(source.id, sourceId));
    if (row === undefined) return false;

    const entries =
      resolveField(yield* Providers, yield* tracklistAssertions(sourceId), field, Entries) ?? [];
    const titles = [...new Set(entries.map((entry) => entry.title))];
    const matched = new Map(
      (titles.length === 0
        ? []
        : yield* db
            .select()
            .from(sourceSegment)
            .where(
              and(inArray(sourceSegment.rawTitle, titles), isNotNull(sourceSegment.recordingId)),
            )
      ).map((segment) => [
        entryKey({ artist: segment.rawArtist, title: segment.rawTitle }),
        segment.recordingId,
      ]),
    );

    const starts = entries.flatMap((entry) => entry.startMs ?? []);
    const segments = entries.map((entry, position) => {
      const start = entry.startMs;
      const end =
        start === null
          ? null
          : Math.min(...starts.filter((other) => other > start), row.rawDurationMs ?? Infinity);
      return {
        sourceId,
        position,
        recordingId: matched.get(entryKey(entry)) ?? null,
        rawArtist: entry.artist,
        rawTitle: entry.title,
        startMs: start,
        endMs: end === Infinity ? null : end,
      };
    });

    const current = yield* db
      .select()
      .from(sourceSegment)
      .where(eq(sourceSegment.sourceId, sourceId))
      .orderBy(asc(sourceSegment.position));
    if (JSON.stringify(current) === JSON.stringify(segments)) return false;

    yield* db.delete(sourceSegment).where(eq(sourceSegment.sourceId, sourceId));
    if (segments.length > 0) yield* db.insert(sourceSegment).values(segments);
    // Segments belong to the group of the set recording
    if (row.recordingId !== null) yield* touchGroups([row.recordingId]);
    return true;
  });

// `ID - ID` and similar are tracks that the DJ does not name
const unknownText = /^(?:id|\?+|unknown)$/i;

// Tracklists add the label in brackets, `(Original Mix)` and `(unreleased)`, which MusicBrainz
// titles omit
const lookupTitle = (title: string) =>
  title
    .replaceAll(/\s*\[[^\]]*\]/g, "")
    .replaceAll(/\s*\((?:original mix|unreleased)\)/gi, "")
    .trim();

const lookupText = (segment: {
  readonly rawArtist: string | null;
  readonly rawTitle: string | null;
}) => {
  const artist = segment.rawArtist?.trim() ?? "";
  const title = lookupTitle(segment.rawTitle ?? "");
  if (artist === "" || title === "" || unknownText.test(artist) || unknownText.test(title)) {
    return undefined;
  }
  return { artist, title };
};

// A remix is another recording, so the whole title must agree, and the first artist
const fits =
  (text: { readonly artist: string; readonly title: string }) =>
  (candidate: MusicBrainzRecording) =>
    normalizeText(candidate.title) === normalizeText(text.title) &&
    normalizeArtist(candidate.artist ?? "") === normalizeArtist(text.artist);

const unmatchedSegments = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select()
      .from(sourceSegment)
      .where(and(eq(sourceSegment.sourceId, sourceId), isNull(sourceSegment.recordingId)));
    return rows.flatMap((row) => {
      const text = lookupText(row);
      return text === undefined ? [] : [{ row, text }];
    });
  });

const queueMatch = (sourceId: string) =>
  Effect.gen(function* () {
    if (!(yield* MusicBrainzLookups).has(musicbrainzLookupKey)) return;
    if ((yield* unmatchedSegments(sourceId)).length === 0) return;
    yield* (yield* Jobs).enqueue(matchKind, sourceId, { sourceId, after: -1 }, { replace: true });
  });

/**
 * Reads the tracklists of a provider source in the background when it plays, at most once a day.
 * Call it after the source is in the catalog.
 */
export const queueTracklistRead = (sourceId: string, userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const tracklists = yield* Tracklists;
    const now = yield* Clock.currentTimeMillis;
    const readAt = tracklists.readAt.get(sourceId);
    if (readAt !== undefined && now - readAt < rereadAfterMs) return;

    const [row] = yield* db
      .select({ provider: source.provider })
      .from(source)
      .where(eq(source.id, sourceId));
    if (row === undefined || (yield* Providers).get(row.provider)?.tracklists === undefined) return;

    tracklists.readAt.set(sourceId, now);
    // The user waits for it, so it runs before imports and lookups
    yield* (yield* Jobs).enqueue(readKind, sourceId, { sourceId, userId }, { priority: 1 });
  });

const ReadPayload = Schema.Struct({ sourceId: Schema.String, userId: UserId });

const runRead = ({ sourceId, userId }: typeof ReadPayload.Type) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db.select().from(source).where(eq(source.id, sourceId));
    if (row === undefined) return;

    const usable = (yield* usableProviders(userId)).get(row.provider);
    const read = usable?.provider.tracklists;
    if (usable === undefined || read === undefined) return;

    // A failed read changes nothing, and the next play tries again
    const tracklists = yield* read(row.externalId, usable.credentials).pipe(
      Effect.catchTag("ProviderError", (error) =>
        Effect.gen(function* () {
          (yield* Tracklists).readAt.delete(sourceId);
          yield* Effect.logWarning("Cannot read the tracklists").pipe(
            Effect.annotateLogs({ sourceId, reason: error.reason }),
          );
          return undefined;
        }),
      ),
    );
    if (tracklists === undefined) return;

    const changed = yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* assertProviderTracklists(sourceId, `${row.provider}:${row.externalId}`, tracklists);
        return yield* deriveSegments(sourceId);
      }),
    );
    if (changed) yield* publish(sourceId);
    yield* queueMatch(sourceId);
  });

const matchedRecording = (candidate: MusicBrainzRecording) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const id = yield* musicbrainzRecordingId(candidate.mbid);
    yield* db
      .insert(recording)
      .values({ id, origin: "musicbrainz", policyVersion: 1, revision: 0 })
      .onConflictDoNothing();
    yield* assertRecording(id, "musicbrainz", candidate.mbid, {
      title: candidate.title,
      artist_credit:
        candidate.artist === null
          ? null
          : {
              name: candidate.artist,
              artists: candidate.artists.map((artist) => ({ id: artist.id, name: artist.name })),
            },
      duration_ms: candidate.durationMs,
    });
    return id;
  });

const writeMatch = (row: typeof sourceSegment.$inferSelect, candidate: MusicBrainzRecording) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const id = yield* matchedRecording(candidate);
    // A read during the lookup can have changed the segment
    yield* db
      .update(sourceSegment)
      .set({ recordingId: id })
      .where(
        and(
          eq(sourceSegment.sourceId, row.sourceId),
          eq(sourceSegment.position, row.position),
          eq(sourceSegment.rawTitle, row.rawTitle ?? ""),
          isNull(sourceSegment.recordingId),
        ),
      );
    yield* projectRecordings([id]);

    const [set] = yield* db
      .select({ recordingId: source.recordingId })
      .from(source)
      .where(eq(source.id, row.sourceId));
    if (set?.recordingId != null) yield* touchGroups([set.recordingId]);
  });

const MatchPayload = Schema.Struct({
  sourceId: Schema.String,
  /** The segments up to this position are looked up */
  after: Schema.Int,
});

// The ListenBrainz mapper, then the MusicBrainz search. MusicBrainz is often busy for a minute
// (October 2026), so each segment keeps its match and the job continues after the last one.
const runMatch = ({ sourceId, after }: typeof MatchPayload.Type) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;
    const lookup = (yield* MusicBrainzLookups).get(musicbrainzLookupKey);
    // The plugin failed to start; the job waits for the next start
    if (lookup === undefined) return yield* new RetryLater({ retryAfterSeconds: 60 * 60 });

    const unmatched = (yield* unmatchedSegments(sourceId))
      .filter(({ row }) => row.position > after)
      .toSorted((a, b) => a.row.position - b.row.position);

    for (const { row, text } of unmatched) {
      const key = String(row.position);
      const found = yield* lookup.recordingsByText([{ key, ...text }]).pipe(Effect.result);
      if (Result.isFailure(found)) {
        const error = found.failure;
        if (error.retryAfterSeconds === null) return yield* error;

        const retryAfterSeconds = Math.max(error.retryAfterSeconds, busyWaitSeconds);
        yield* jobs.enqueue(
          matchKind,
          sourceId,
          { sourceId, after: row.position - 1 },
          { runAt: (yield* Clock.currentTimeMillis) + retryAfterSeconds * 1000 },
        );
        return;
      }

      const candidate = found.success.get(key)?.find(fits(text));
      if (candidate === undefined) continue;

      yield* db.transaction(() => writeMatch(row, candidate));
      yield* publish(sourceId);
    }
  });

/** The segments of the source, with the canonical fields of the matched recordings */
const segmentsOf = (sourceId: string, userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select()
      .from(sourceSegment)
      .where(eq(sourceSegment.sourceId, sourceId))
      .orderBy(asc(sourceSegment.position));

    const matchedIds = [...new Set(rows.flatMap((row) => row.recordingId ?? []))];
    const bound = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, matchedIds));
    const rootOf = new Map(bound.map((row) => [row.id, row.mergedIntoId ?? row.id]));
    const rootIds = [...new Set(rootOf.values())];
    const groups = yield* db
      .select()
      .from(recording)
      .where(or(inArray(recording.id, rootIds), inArray(recording.mergedIntoId, rootIds)));
    const roots = new Map(groups.map((row) => [row.id, row]));
    for (const member of groups) rootOf.set(member.id, member.mergedIntoId ?? member.id);

    // A source of the same song gives the pages to open
    const playable =
      groups.length === 0
        ? []
        : yield* playableSources(
            userId,
            inArray(
              source.recordingId,
              groups.map((row) => row.id),
            ),
          );
    const pagesOf = new Map<string, ReturnType<typeof sourceSummary>>();
    for (const row of playable) {
      const root = rootOf.get(row.source.recordingId ?? "");
      const summary = sourceSummary(row);
      const known = pagesOf.get(root ?? "");
      if (root !== undefined && (known === undefined || known.artistRef === null)) {
        pagesOf.set(root, summary);
      }
    }

    return rows.map((row) => {
      const root = rootOf.get(row.recordingId ?? "") ?? "";
      const canonical = roots.get(root);
      const pages = pagesOf.get(root);
      return new SourceSegment({
        startMs: row.startMs,
        endMs: row.endMs,
        title: canonical?.title ?? row.rawTitle ?? "",
        artist: canonical?.artistName ?? row.rawArtist,
        album: pages?.album ?? canonical?.album ?? null,
        artistRef: pages?.artistRef ?? null,
        albumRef: pages?.albumRef ?? null,
      });
    });
  });

export const sourceSegments = (sourceId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const principal = yield* CurrentPrincipal;
      const subscription = yield* PubSub.subscribe((yield* Tracklists).changes);

      return Stream.concat(
        Stream.succeed(sourceId),
        Stream.fromSubscription(subscription).pipe(Stream.filter((id) => id === sourceId)),
      ).pipe(Stream.mapEffect(() => segmentsOf(sourceId, principal.userId)));
    }),
  );

/**
 * An admin assertion without a value hides the provider tracklists, and with them the segments.
 * `hidden: false` withdraws it.
 */
export const hideTracklist = (sourceId: string, hidden: boolean) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;

    const [author] = yield* db
      .select({ role: user.role })
      .from(user)
      .where(eq(user.id, principal.userId));
    if (author?.role !== "admin") return yield* new TracklistEditFailed({ reason: "not_admin" });

    const [row] = yield* db.select({ id: source.id }).from(source).where(eq(source.id, sourceId));
    if (row === undefined) return yield* new TracklistEditFailed({ reason: "source_not_found" });

    const admin = { origin: "admin", originRef: "workspace" } as const;
    const changed = yield* db.transaction(() =>
      Effect.gen(function* () {
        if (hidden) {
          yield* assertTracklist(sourceId, {
            ...admin,
            value: null,
            confidence: 1,
            authorUserId: principal.userId,
          });
        } else {
          const id = yield* assertionId({
            entityType: "source",
            entityId: sourceId,
            field,
            ...admin,
          });
          const known = yield* tracklistAssertions(sourceId);
          if (known.some((assertion) => assertion.id === id)) yield* retract([id]);
        }
        return yield* deriveSegments(sourceId);
      }),
    );
    if (changed) yield* publish(sourceId);
    yield* queueMatch(sourceId);
  });

/** Build it after the plugins, so that a read finds the provider and the MusicBrainz lookups */
export const tracklistsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    yield* jobs.register(readKind, ReadPayload, runRead);
    yield* jobs.register(matchKind, MatchPayload, runMatch);
  }),
);
