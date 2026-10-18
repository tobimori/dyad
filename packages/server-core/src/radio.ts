import { recording, source, sourceSegment } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, RadioStart } from "@dyad/domain";
import type { QueueEntry, SourceSummary, UserId } from "@dyad/domain";
import { RadioSeed } from "@dyad/plugin";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Clock, Data, Effect, Option } from "effect";

import { cachedProviderSource, cachedSummary } from "./provider-cache.ts";
import { usableProviders } from "./providers.ts";
import { RecommendationMemory, Recommenders, recommenderAccount } from "./recommenders.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { resolveSuggestions } from "./suggestions.ts";
import { Pick, choose, loadTaste, songKey } from "./taste.ts";

const startLimit = 25;
const refillLimit = 10;
// Searches for suggestions without a source, per radio
const radioSearches = 5;
const answerTimeout = "8 seconds";
const radioLifetimeMs = 10 * 60 * 1000;
// Below the first suggestions of the recommenders, which know more songs
const neighbourScore = 0.15;

class Seed extends Data.Class<{
  readonly title: string | null;
  readonly artist: string;
  /** What the reasons call the seed */
  readonly label: string;
  readonly summary: SourceSummary | null;
  readonly externalId: string | null;
}> {}

const sourceSeed = (userId: UserId, sourceId: string) =>
  Effect.gen(function* () {
    const [row] = yield* playableSources(userId, eq(source.id, sourceId), 1);
    if (row !== undefined) {
      const summary = sourceSummary(row);
      return Option.some({ summary, externalId: row.source.externalId });
    }
    const cached = yield* cachedProviderSource(sourceId);
    const name = Option.isSome(cached)
      ? (yield* usableProviders(userId)).get(cached.value.provider)?.provider.name
      : undefined;
    return Option.map(
      Option.filter(cached, () => name !== undefined),
      (item) => ({
        summary: cachedSummary(item, name ?? item.provider),
        externalId: item.source.externalId,
      }),
    );
  });

const seedOf = (userId: UserId, start: typeof RadioStart.Type) =>
  RadioStart.match(start, {
    Artist: ({ name }) =>
      Effect.succeed(
        Option.some(
          new Seed({ title: null, artist: name, label: name, summary: null, externalId: null }),
        ),
      ),
    Source: ({ sourceId }) =>
      Effect.map(sourceSeed(userId, sourceId), (found) =>
        Option.flatMap(found, ({ summary, externalId }) =>
          summary.artist === null
            ? Option.none()
            : Option.some(
                new Seed({
                  title: summary.title,
                  artist: summary.artist,
                  label: summary.title ?? summary.artist,
                  summary,
                  externalId,
                }),
              ),
        ),
      ),
  });

// The songs before and after the seed in DJ sets, or the songs of a seed that is a set
const setNeighbours = (userId: UserId, seed: Seed) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const summary = seed.summary;
    if (summary === null) return [];

    const root = sql<string>`coalesce(${recording.mergedIntoId}, ${recording.id})`;
    const own = yield* db
      .select({ recordingId: sourceSegment.recordingId })
      .from(sourceSegment)
      .where(eq(sourceSegment.sourceId, summary.id));
    const group =
      summary.recordingId === null
        ? []
        : yield* db
            .select({ id: recording.id })
            .from(recording)
            .where(
              eq(
                root,
                db.select({ root }).from(recording).where(eq(recording.id, summary.recordingId)),
              ),
            );
    const places = yield* db
      .select({ sourceId: sourceSegment.sourceId, position: sourceSegment.position })
      .from(sourceSegment)
      .where(
        inArray(
          sourceSegment.recordingId,
          group.map((member) => member.id),
        ),
      );
    const near =
      places.length === 0
        ? []
        : yield* db
            .select({ recordingId: sourceSegment.recordingId, set: source.rawTitle })
            .from(sourceSegment)
            .innerJoin(source, eq(source.id, sourceSegment.sourceId))
            .where(
              or(
                ...places.map((place) =>
                  and(
                    eq(sourceSegment.sourceId, place.sourceId),
                    inArray(sourceSegment.position, [place.position - 1, place.position + 1]),
                  ),
                ),
              ),
            );

    const reasons = new Map<string, string>();
    for (const segment of own) {
      if (segment.recordingId !== null) {
        reasons.set(segment.recordingId, `From the set ${seed.label}`);
      }
    }
    for (const segment of near) {
      if (segment.recordingId !== null && !reasons.has(segment.recordingId)) {
        reasons.set(
          segment.recordingId,
          `Played next to ${seed.label} in ${segment.set ?? "a DJ set"}`,
        );
      }
    }
    if (reasons.size === 0) return [];

    // The playable sources of the merge groups of the segments
    const roots = yield* db
      .select({ id: recording.id, root })
      .from(recording)
      .where(inArray(recording.id, [...reasons.keys()]));
    const reasonOfRoot = new Map(roots.map((row) => [row.root, reasons.get(row.id) ?? ""]));
    const members = yield* db
      .select({ id: recording.id, root })
      .from(recording)
      .where(inArray(root, [...reasonOfRoot.keys()]));
    const rootOf = new Map(members.map((member) => [member.id, member.root]));
    const rows = yield* playableSources(
      userId,
      inArray(
        source.recordingId,
        members.map((member) => member.id),
      ),
    );
    return rows.flatMap((row, position) => {
      const reason = reasonOfRoot.get(rootOf.get(row.source.recordingId ?? "") ?? "");
      return reason === undefined
        ? []
        : [
            new Pick({
              summary: sourceSummary(row),
              score: neighbourScore / (1 + position / 10),
              reason,
            }),
          ];
    });
  });

/**
 * Songs after the seed from every recommender with a radio, highest priority first, and from DJ
 * sets, ranked by the user's plays. A recommender that fails or does not answer in time is skipped.
 */
const radioTracks = (
  userId: UserId,
  seed: Seed,
  options: { readonly exclude: ReadonlySet<string>; readonly limit: number },
) =>
  Effect.gen(function* () {
    const recommenders = yield* Recommenders;
    const answers = yield* Effect.forEach(
      [...recommenders].filter(([, recommender]) => recommender.radio !== undefined),
      ([id, recommender]) =>
        Effect.gen(function* () {
          const radio = recommender.radio;
          if (radio === undefined) return [];
          const account = yield* recommenderAccount(userId, id);
          const credentials = Option.match(account, {
            onNone: () => new Map(),
            onSome: (linked) => linked.credentials,
          });
          const ownSeed = seed.summary?.provider === id ? seed.externalId : null;
          const suggestions = yield* radio(
            new RadioSeed({ title: seed.title, artist: seed.artist, externalId: ownSeed }),
            credentials,
          ).pipe(
            Effect.timeout(answerTimeout),
            Effect.catchTags({
              ProviderError: (error) =>
                Effect.logWarning("Radio failed", error.reason).pipe(Effect.as([])),
              TimeoutError: () => Effect.logWarning("Radio timed out").pipe(Effect.as([])),
            }),
            Effect.catchDefect((defect) =>
              Effect.logError("Radio crashed", defect).pipe(Effect.as([])),
            ),
            Effect.annotateLogs("recommender", id),
          );
          return suggestions.map((suggestion, position) => ({
            suggestion,
            recommender: id,
            score: (recommender.priority ?? 0) / 100 + 0.5 / (1 + position),
            reason: seed.title === null ? `Like ${seed.label}` : `Because you played ${seed.label}`,
          }));
        }),
      { concurrency: "unbounded" },
    );
    const items = answers.flat().toSorted((a, b) => b.score - a.score);
    const found = yield* resolveSuggestions(userId, items, radioSearches);
    const picks = items.flatMap((item, index) => {
      const summary = found[index];
      return summary === undefined ? [] : [new Pick({ ...item, summary })];
    });
    const neighbours = yield* setNeighbours(userId, seed);

    const exclude = new Set(options.exclude);
    if (seed.summary !== null) {
      exclude.add(seed.summary.id);
      exclude.add(songKey(seed.summary.title, seed.summary.artist));
    }
    return choose(yield* loadTaste(userId), [...picks, ...neighbours], {
      exclude,
      limit: options.limit,
      explainArtist: false,
    });
  });

/** The same start gives the same songs for 10 minutes, without new provider requests */
export const radio = (start: typeof RadioStart.Type) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const memory = yield* RecommendationMemory;
    const now = yield* Clock.currentTimeMillis;
    const key = `${principal.userId}:${JSON.stringify(start)}`;
    const earlier = memory.radios.get(key);
    if (earlier !== undefined && now - earlier.at < radioLifetimeMs) return earlier.tracks;

    const seed = yield* seedOf(principal.userId, start);
    if (Option.isNone(seed)) return [];
    const tracks = yield* radioTracks(principal.userId, seed.value, {
      exclude: new Set(),
      limit: startLimit,
    });

    for (const [other, entry] of memory.radios) {
      if (now - entry.at >= radioLifetimeMs) memory.radios.delete(other);
    }
    memory.radios.set(key, { tracks, at: now });
    return tracks;
  });

/** More songs after the last entry of a queue, without the songs of the queue */
export const continueRadio = (userId: UserId, entries: ReadonlyArray<QueueEntry>) =>
  Effect.gen(function* () {
    const last = entries.at(-1);
    if (last === undefined) return [];
    const seed = yield* seedOf(userId, RadioStart.cases.Source.make({ sourceId: last.source.id }));
    if (Option.isNone(seed)) return [];

    const exclude = new Set(
      entries.flatMap((entry) => [
        entry.source.id,
        songKey(entry.source.title, entry.source.artist),
      ]),
    );
    return yield* radioTracks(userId, seed.value, { exclude, limit: refillLimit });
  });
