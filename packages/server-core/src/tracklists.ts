import { catalogAssertion, policyVersion, recording, source, sourceSegment } from "@dyad/db";
import { Database, ReplicaDatabase } from "@dyad/db/node";
import { RecordingId, SourceSegment, TracklistEditFailed } from "@dyad/domain";
import { TracklistEntry } from "@dyad/plugin";
import type {
  MusicBrainzRecording,
  PluginContext,
  ProviderError,
  ProviderTracklist,
} from "@dyad/plugin";
import { artistNameKey, eventWords } from "@dyad/plugin/tracklist";
import { HlcClock } from "@dyad/sync";
import { and, asc, between, eq, inArray, isNotNull, isNull, ne, or } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Option, PubSub, Result, Schema, Stream } from "effect";

import { fields, projectRecordings, resolveField, resolvedValues } from "./assertions.ts";
import { assertionId, uuidV5 } from "./ids.ts";
import { Jobs, RetryLater } from "./jobs.ts";
import {
  MusicBrainzLookups,
  assertMusicBrainzRecording,
  musicbrainzLookupKey,
  tracklistMatchKind,
  waitForMusicBrainz,
} from "./matching.ts";
import { normalizeArtist, normalizeText } from "./normalize.ts";
import { FactRanks, Providers, usableProviders } from "./providers.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";

const readKind = "tracklist.read";
const field = "tracklist";
const Entries = Schema.Array(TracklistEntry);

// Descriptions and comments change, so a play reads the tracklists again after a day
const rereadAfterMs = 24 * 60 * 60 * 1000;
// A tracklist site cannot beat a description or chapters, so the read does not ask it
const goodConfidence = 0.8;
// Uploads of one set differ by an intro or an outro
const copyToleranceMs = (a: number, b: number) => Math.max(30_000, 0.02 * Math.max(a, b));
// A different intro moves all times, so a copy keeps them only for nearly the same duration
const sameTimingMs = 5000;

const makeTracklists = Effect.gen(function* () {
  return {
    /** The IDs of sources whose segments changed */
    changes: yield* PubSub.unbounded<string>(),
    /** When this process last queued a read of each source */
    readAt: new Map<string, number>(),
    /** The lookups of tracklist sites, by the ID that starts their origin refs */
    sites: new Map<string, Parameters<PluginContext["tracklists"]["add"]>[1]>(),
  };
});

export class Tracklists extends Context.Service<
  Tracklists,
  Effect.Success<typeof makeTracklists>
>()("@dyad/server-core/Tracklists") {}

export const tracklistsServiceLayer = Layer.effect(Tracklists, makeTracklists);

const publish = Effect.fn(function* (sourceId: string) {
  yield* PubSub.publish((yield* Tracklists).changes, sourceId);
});

// An unchanged assertion writes nothing
const writeAssertion = Effect.fn(function* (
  target: { readonly entityType: string; readonly entityId: string; readonly field: string },
  assertion: {
    readonly origin: "plugin" | "admin" | "match";
    readonly originRef: string;
    readonly value: unknown;
    readonly confidence: number;
    readonly evidence: unknown;
  },
) {
  const db = yield* Database;
  const identity = yield* ReplicaDatabase;
  const id = yield* assertionId({ ...target, ...assertion });

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
    ...target,
    ...assertion,
    originRevision: null,
    authorReplicaId: identity.replicaId,
    hlc: yield* (yield* HlcClock).next,
    retracted: false,
    schemaVersion: 1,
  };
  yield* db.transaction(() =>
    Effect.gen(function* () {
      const values = { ...row, changeSeq: yield* nextChangeSeq };
      yield* db
        .insert(catalogAssertion)
        .values(values)
        .onConflictDoUpdate({ target: catalogAssertion.id, set: values });
    }),
  );
  return id;
});

const assertTracklist = (
  sourceId: string,
  assertion: {
    readonly origin: "plugin" | "admin";
    readonly originRef: string;
    readonly value: typeof Entries.Encoded | null;
    readonly confidence: number;
  },
) =>
  writeAssertion(
    { entityType: "source", entityId: sourceId, field },
    { ...assertion, evidence: null },
  );

// A match of a tracklist text is an assertion, so that each server replica derives the same segments
const entryEntity = (entry: { readonly artist: string | null; readonly title: string | null }) =>
  uuidV5(`tracklist_entry:${entryKey(entry)}`).pipe(
    Effect.map((entityId) => ({ entityType: "tracklist_entry", entityId, field: "recording" })),
  );

/** The raw text of a tracklist entry, in the evidence of its match */
export const EntryText = Schema.Struct({ artist: Schema.String, title: Schema.String });

const retract = Effect.fn(function* (ids: ReadonlyArray<string>) {
  if (ids.length === 0) return;
  const db = yield* Database;
  const hlc = yield* (yield* HlcClock).next;
  yield* db.transaction(() =>
    Effect.gen(function* () {
      yield* db
        .update(catalogAssertion)
        .set({ retracted: true, hlc, changeSeq: yield* nextChangeSeq })
        .where(inArray(catalogAssertion.id, [...ids]));
    }),
  );
});

const tracklistAssertions = Effect.fn(function* (sourceId: string) {
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

// The candidates with the origin ref `prefix` that a read no longer finds are withdrawn
const assertProviderTracklists = Effect.fn(function* (
  sourceId: string,
  prefix: string,
  tracklists: ReadonlyArray<ProviderTracklist>,
) {
  const written = yield* Effect.forEach(tracklists, (tracklist) =>
    assertTracklist(sourceId, {
      origin: "plugin",
      originRef: `${prefix}${tracklist.part}`,
      value: Schema.encodeSync(Entries)(tracklist.entries),
      confidence: tracklist.confidence,
    }),
  );
  const lost = (yield* tracklistAssertions(sourceId)).filter(
    (assertion) =>
      assertion.origin === "plugin" &&
      assertion.originRef.startsWith(prefix) &&
      !written.includes(assertion.id),
  );
  yield* retract(lost.map((assertion) => assertion.id));
});

// An admin edit wins, and without entries it hides the tracklist. Candidates of several plugins
// compare by confidence, which they set on one scale.
const selectTracklist = (assertions: ReadonlyArray<typeof catalogAssertion.$inferSelect>) => {
  const [selected] = assertions
    .flatMap((assertion) => {
      const admin = assertion.origin === "admin";
      if (assertion.value === null && !admin) return [];
      const entries =
        assertion.value === null
          ? Option.some(null)
          : Schema.decodeUnknownOption(Entries)(assertion.value);
      return Option.isSome(entries) ? [{ assertion, admin, entries: entries.value }] : [];
    })
    .toSorted(
      (a, b) =>
        Number(b.admin) - Number(a.admin) ||
        b.assertion.confidence - a.assertion.confidence ||
        b.assertion.hlc.localeCompare(a.assertion.hlc) ||
        a.assertion.id.localeCompare(b.assertion.id),
    );
  return selected;
};

// The DJs of each recording that is a set, from its own assertions
const setArtists = Effect.fn(function* (recordingIds: ReadonlyArray<string>) {
  const sets = yield* resolvedValues(recordingIds, "set", fields.set);
  const credits = yield* resolvedValues(recordingIds, "artist_credit", fields.artist_credit);
  return new Map(
    recordingIds.flatMap((id) => {
      const artists = credits.get(id)?.artists.map((artist) => artist.name) ?? [];
      return sets.get(id) === true && artists.length > 0 ? [[id, artists] as const] : [];
    }),
  );
});

// The other sources of the same set: the same DJs and event words, and nearly the same duration
const setCopies = Effect.fn(function* (sourceId: string) {
  const db = yield* Database;
  const [row] = yield* db.select().from(source).where(eq(source.id, sourceId));
  const durationMs = row?.rawDurationMs ?? null;
  if (row?.recordingId == null || durationMs === null) return [];

  const candidates = yield* db
    .select()
    .from(source)
    .where(
      and(
        ne(source.id, sourceId),
        isNotNull(source.recordingId),
        between(source.rawDurationMs, durationMs * 0.98 - 30_000, durationMs / 0.98 + 30_000),
      ),
    );
  const sets = yield* setArtists([
    row.recordingId,
    ...candidates.flatMap((candidate) => candidate.recordingId ?? []),
  ]);
  const artists = sets.get(row.recordingId);
  if (artists === undefined) return [];

  const key = (names: ReadonlyArray<string>) => names.map(artistNameKey).toSorted().join(" ");
  // The parsed title drops words such as the year of an `Essential Mix`
  const words = eventWords(row.rawTitle ?? "", artists);
  return candidates.flatMap((candidate) => {
    const other = sets.get(candidate.recordingId ?? "");
    const offMs = Math.abs((candidate.rawDurationMs ?? Infinity) - durationMs);
    if (other === undefined || key(other) !== key(artists)) return [];
    if (offMs > copyToleranceMs(durationMs, candidate.rawDurationMs ?? 0)) return [];

    // `Boiler Room` and `Boiler Room London` name the same event, `London` and `Berlin` do not
    const otherWords = eventWords(candidate.rawTitle ?? "", other);
    const [fewer, more] =
      words.length <= otherWords.length ? [words, otherWords] : [otherWords, words];
    const same = fewer.length > 0 && fewer.every((word) => more.includes(word));
    return same ? [{ id: candidate.id, offMs }] : [];
  });
});

// The best tracklist that a copy selected from its own candidates. Without nearly the same
// duration, its entries have no times.
const copyTracklist = Effect.fn(function* (sourceId: string) {
  const copies = yield* setCopies(sourceId);
  const lists = yield* Effect.forEach(copies, (copy) =>
    Effect.gen(function* () {
      const selected = selectTracklist(yield* tracklistAssertions(copy.id));
      if (selected?.entries == null) return [];
      const timed = copy.offMs <= sameTimingMs;
      const confidence = selected.assertion.confidence;
      return [
        {
          ...copy,
          confidence: timed ? confidence : Math.min(confidence, 0.5),
          entries: timed
            ? selected.entries
            : selected.entries.map(
                (entry) =>
                  new TracklistEntry({ startMs: null, artist: entry.artist, title: entry.title }),
              ),
        },
      ];
    }),
  );
  const [best] = lists
    .flat()
    .toSorted(
      (a, b) => b.confidence - a.confidence || a.offMs - b.offMs || a.id.localeCompare(b.id),
    );
  return best;
});

const entryKey = (entry: { readonly artist: string | null; readonly title: string | null }) =>
  JSON.stringify([entry.artist, entry.title]);

/**
 * Makes the segments of the source from its selected tracklist, or from the tracklist of a copy
 * that is better. A segment gets the match of its text, also when another source found it.
 * Returns whether a segment changed.
 */
const deriveSegments = Effect.fn(function* (sourceId: string) {
  const db = yield* Database;
  const [row] = yield* db.select().from(source).where(eq(source.id, sourceId));
  if (row === undefined) return false;

  const own = selectTracklist(yield* tracklistAssertions(sourceId));
  const copy = own?.admin === true ? undefined : yield* copyTracklist(sourceId);
  const entries =
    copy !== undefined && copy.confidence > (own?.assertion.confidence ?? 0)
      ? copy.entries
      : (own?.entries ?? []);
  const targets = new Map(
    yield* Effect.forEach(entries, (entry) =>
      entryEntity(entry).pipe(Effect.map((target) => [entryKey(entry), target.entityId] as const)),
    ),
  );
  const matches =
    targets.size === 0
      ? []
      : yield* db
          .select()
          .from(catalogAssertion)
          .where(
            and(
              eq(catalogAssertion.entityType, "tracklist_entry"),
              inArray(catalogAssertion.entityId, [...targets.values()]),
              eq(catalogAssertion.retracted, false),
            ),
          );
  const ranks = yield* FactRanks;
  const matchOf = (entry: TracklistEntry) =>
    resolveField(
      ranks,
      matches.filter((match) => match.entityId === targets.get(entryKey(entry))),
      "recording",
      Schema.String,
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
      recordingId: matchOf(entry),
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

// The copies of a set can select the tracklist of the source, so they change with it
const deriveWithCopies = Effect.fn(function* (sourceId: string) {
  const copies = yield* setCopies(sourceId);
  const changed = yield* Effect.forEach([sourceId, ...copies.map((copy) => copy.id)], (id) =>
    deriveSegments(id).pipe(Effect.map((derived) => (derived ? [id] : []))),
  );
  return changed.flat();
});

/** Makes the segments again after tracklist assertions came from another server replica */
export const deriveTracklists = Effect.fn("deriveTracklists")(function* (
  sourceIds: Iterable<string>,
) {
  const changed = yield* Effect.forEach(new Set(sourceIds), deriveWithCopies);
  yield* Effect.forEach(new Set(changed.flat()), publish, { discard: true });
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

const unmatchedSegments = Effect.fn(function* (sourceId: string) {
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

const queueMatch = Effect.fn(function* (sourceId: string) {
  if (!(yield* MusicBrainzLookups).has(musicbrainzLookupKey)) return;
  if ((yield* unmatchedSegments(sourceId)).length === 0) return;
  yield* (yield* Jobs).enqueue(
    tracklistMatchKind,
    sourceId,
    { sourceId, after: -1 },
    { replace: true },
  );
});

/**
 * Reads the tracklists of a provider source and, for a set, of the tracklist sites in the
 * background when it plays, at most once a day. Call it after the source is in the catalog.
 */
export const queueTracklistRead = Effect.fn("queueTracklistRead")(function* (sourceId: string) {
  const db = yield* Database;
  const tracklists = yield* Tracklists;
  const now = yield* Clock.currentTimeMillis;
  const readAt = tracklists.readAt.get(sourceId);
  if (readAt !== undefined && now - readAt < rereadAfterMs) return;

  const [row] = yield* db
    .select({ provider: source.provider })
    .from(source)
    .where(eq(source.id, sourceId));
  if (row === undefined) return;
  const provider = (yield* Providers).get(row.provider);
  if (provider?.tracklists === undefined && tracklists.sites.size === 0) return;

  tracklists.readAt.set(sourceId, now);
  // The user waits for it, so it runs before imports and lookups
  yield* (yield* Jobs).enqueue(readKind, sourceId, { sourceId }, { priority: 1 });
});

const ReadPayload = Schema.Struct({ sourceId: Schema.String });

const runRead = Effect.fn(function* ({ sourceId }: typeof ReadPayload.Type) {
  const db = yield* Database;
  const tracklists = yield* Tracklists;
  const [row] = yield* db.select().from(source).where(eq(source.id, sourceId));
  if (row === undefined) return;

  // A failed read changes nothing, and the next play tries again
  const failed = Effect.fn(function* (error: ProviderError) {
    tracklists.readAt.delete(sourceId);
    yield* Effect.logWarning("Cannot read the tracklists").pipe(
      Effect.annotateLogs({ sourceId, reason: error.reason }),
    );
    return undefined;
  });

  const usable = (yield* usableProviders).get(row.provider);
  const read = usable?.provider.tracklists;
  const own =
    usable === undefined || read === undefined
      ? undefined
      : yield* read(row.externalId, usable.credentials).pipe(
          Effect.catchTag("ProviderError", failed),
        );

  const artists =
    row.recordingId === null
      ? undefined
      : (yield* setArtists([row.recordingId])).get(row.recordingId);
  const good = own?.some((tracklist) => tracklist.confidence >= goodConfidence) === true;
  const sites =
    artists === undefined || good
      ? []
      : yield* Effect.forEach([...tracklists.sites], ([id, lookup]) =>
          lookup({ artists, title: row.rawTitle ?? "", durationMs: row.rawDurationMs }).pipe(
            Effect.map((found) => ({ id, found })),
            Effect.catchTag("ProviderError", failed),
          ),
        );

  const changed = yield* db.transaction(() =>
    Effect.gen(function* () {
      if (own !== undefined) {
        yield* assertProviderTracklists(sourceId, `${row.provider}:${row.externalId}#`, own);
      }
      for (const site of sites) {
        if (site !== undefined)
          yield* assertProviderTracklists(sourceId, `${site.id}:`, site.found);
      }
      return yield* deriveWithCopies(sourceId);
    }),
  );
  yield* Effect.forEach(changed, publish, { discard: true });
  yield* Effect.forEach(new Set([sourceId, ...changed]), queueMatch, { discard: true });
});

/** Derives the segments again of the sources whose tracklists have one of the texts */
export const deriveEntryMatches = Effect.fn("deriveEntryMatches")(function* (
  texts: ReadonlyArray<typeof EntryText.Type>,
) {
  const db = yield* Database;
  const rows = yield* Effect.forEach(texts, (text) =>
    db
      .selectDistinct({ sourceId: sourceSegment.sourceId })
      .from(sourceSegment)
      .where(and(eq(sourceSegment.rawArtist, text.artist), eq(sourceSegment.rawTitle, text.title))),
  );
  const changed = yield* Effect.filter(
    new Set(rows.flat().map((row) => row.sourceId)),
    deriveSegments,
  );
  yield* Effect.forEach(changed, publish, { discard: true });
});

const assertMatch = Effect.fn(function* (text: typeof EntryText.Type, recordingId: string) {
  yield* writeAssertion(yield* entryEntity(text), {
    origin: "match",
    originRef: musicbrainzLookupKey,
    value: recordingId,
    confidence: 1,
    evidence: text,
  });
});

/** Asserts the matches of segments that a replica matched before matches were assertions */
export const assertSegmentMatches = Effect.fn("assertSegmentMatches")(function* (
  sourceIds: ReadonlyArray<string>,
) {
  const db = yield* Database;
  const rows =
    sourceIds.length === 0
      ? []
      : yield* db
          .selectDistinct({
            artist: sourceSegment.rawArtist,
            title: sourceSegment.rawTitle,
            recordingId: sourceSegment.recordingId,
          })
          .from(sourceSegment)
          .where(
            and(inArray(sourceSegment.sourceId, sourceIds), isNotNull(sourceSegment.recordingId)),
          );
  yield* Effect.forEach(
    rows,
    ({ artist, title, recordingId }) =>
      artist === null || title === null || recordingId === null
        ? Effect.void
        : assertMatch({ artist, title }, recordingId),
    { discard: true },
  );
});

const writeMatch = Effect.fn(function* (
  text: typeof EntryText.Type,
  candidate: MusicBrainzRecording,
) {
  const db = yield* Database;
  const id = yield* assertMusicBrainzRecording(candidate);
  yield* db
    .insert(recording)
    .values({ id, origin: "musicbrainz", policyVersion, revision: 0 })
    .onConflictDoNothing();
  yield* assertMatch(text, id);
  yield* projectRecordings([id]);
  yield* deriveEntryMatches([text]);
});

const MatchPayload = Schema.Struct({
  sourceId: Schema.String,
  /** The segments up to this position are looked up */
  after: Schema.Int,
});

// The ListenBrainz mapper, then the MusicBrainz search. MusicBrainz is often busy for a minute
// (October 2026), so each segment keeps its match and the job continues after the last one.
const runMatch = Effect.fn(function* ({ sourceId, after }: typeof MatchPayload.Type) {
  const db = yield* Database;
  const jobs = yield* Jobs;
  const lookup = (yield* MusicBrainzLookups).get(musicbrainzLookupKey);
  // The plugin failed to start; the job waits for the next start
  if (lookup === undefined) return yield* new RetryLater({ retryAfterSeconds: 60 * 60 });

  const unmatched = (yield* unmatchedSegments(sourceId))
    .filter(({ row }) => row.position > after)
    .toSorted((a, b) => a.row.position - b.row.position);

  // A match applies to all entries with the same text
  const matched = new Set<string>();
  for (const { row, text } of unmatched) {
    const raw = { artist: row.rawArtist, title: row.rawTitle };
    if (matched.has(entryKey(raw))) continue;
    const key = String(row.position);
    const found = yield* lookup.recordingsByText([{ key, ...text }]).pipe(Effect.result);
    if (Result.isFailure(found)) {
      const error = found.failure;
      if (error.retryAfterSeconds === null) return yield* error;

      const retryAfterSeconds = yield* waitForMusicBrainz(error.retryAfterSeconds);
      yield* jobs.enqueue(
        tracklistMatchKind,
        sourceId,
        { sourceId, after: row.position - 1 },
        { runAt: (yield* Clock.currentTimeMillis) + retryAfterSeconds * 1000 },
      );
      return;
    }

    const candidate = found.success.get(key)?.find(fits(text));
    if (candidate === undefined) continue;

    yield* db.transaction(() =>
      writeMatch({ artist: row.rawArtist ?? "", title: row.rawTitle ?? "" }, candidate),
    );
    matched.add(entryKey(raw));
  }
});

/** The segments of the source, with the canonical fields of the matched recordings */
const segmentsOf = Effect.fn(function* (sourceId: string) {
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
      recordingId: row.recordingId === null ? null : RecordingId.make(row.recordingId),
    });
  });
});

export const sourceSegments = (sourceId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe((yield* Tracklists).changes);

      return Stream.concat(
        Stream.succeed(sourceId),
        Stream.fromSubscription(subscription).pipe(Stream.filter((id) => id === sourceId)),
      ).pipe(Stream.mapEffect(() => segmentsOf(sourceId)));
    }),
  );

/**
 * An admin assertion without a value hides the provider tracklists, and with them the segments.
 * `hidden: false` withdraws it.
 */
export const hideTracklist = Effect.fn("hideTracklist")(function* (
  sourceId: string,
  hidden: boolean,
) {
  const db = yield* Database;

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
      return yield* deriveWithCopies(sourceId);
    }),
  );
  yield* Effect.forEach(changed, publish, { discard: true });
  yield* Effect.forEach(new Set([sourceId, ...changed]), queueMatch, { discard: true });
});

/** Build it after the plugins, so that a read finds the provider and the MusicBrainz lookups */
export const tracklistsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    yield* jobs.register(readKind, ReadPayload, runRead, { homeOnly: true });
    yield* jobs.register(tracklistMatchKind, MatchPayload, runMatch, { homeOnly: true });
  }),
);
