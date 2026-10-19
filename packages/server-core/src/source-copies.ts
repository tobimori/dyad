import { source, sourceVariant } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  CurrentPrincipal,
  RecordingId,
  SourceCopy,
  SourceSummary,
  compareCopies,
  compareSources,
} from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import type { ProviderSource } from "@dyad/plugin";
import { and, eq, inArray, ne } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Option } from "effect";

import { isrcRecordingId } from "./ids.ts";
import { MediaCache } from "./media-cache.ts";
import { normalizeArtist, normalizeTitle } from "./normalize.ts";
import { cacheProviderSources, cachedProviderSource, cachedSummary } from "./provider-cache.ts";
import { Providers, linkedProviders, usableProviders } from "./providers.ts";
import { recordingGroup } from "./sets.ts";
import { providerOrder } from "./source-preference.ts";
import { versionWordsOf } from "./ranking.ts";
import { playableSources, sourceSummary } from "./sources.ts";

// The recordings of the canonical recording of the source. A search result that is not in the
// catalog finds the recordings of its ISRC.
const groupOf = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [own] = yield* db
      .select({ recordingId: source.recordingId })
      .from(source)
      .where(eq(source.id, sourceId));
    const cached = own === undefined ? yield* cachedProviderSource(sourceId) : Option.none();
    const starts =
      own?.recordingId ??
      (yield* Option.match(cached, {
        onNone: () => Effect.succeed(null),
        onSome: (item) => (item.isrc === null ? Effect.succeed(null) : isrcRecordingId(item.isrc)),
      }));
    const group = starts === null ? [] : yield* recordingGroup(starts);
    return { group, cached };
  });

/**
 * The other sources of the recording that the user can play, best first: the user's provider
 * order, then a local file, then a stream in the media cache, then quality
 */
export const playableCopies = (sourceId: string, userId: UserId) =>
  Effect.gen(function* () {
    const cache = yield* MediaCache;
    const { group } = yield* groupOf(sourceId);
    if (group.length === 0) return [];
    const rows = yield* playableSources(
      userId,
      and(inArray(source.recordingId, group), ne(source.id, sourceId)),
    );
    const cached = new Set(
      yield* Effect.filter(rows, (row) => Effect.map(cache.find(row.variant.id), Option.isSome)),
    );
    const compare = compareSources(yield* providerOrder(userId));
    return rows.toSorted(
      (a, b) =>
        compare(
          { provider: a.source.provider, lossless: a.variant.lossless },
          { provider: b.source.provider, lossless: b.variant.lossless },
        ) ||
        Number(cached.has(b)) - Number(cached.has(a)) ||
        (b.variant.bitrate ?? 0) - (a.variant.bitrate ?? 0),
    );
  });

/**
 * All sources of the canonical recording of the source. A search result that is not in the catalog
 * finds the recordings of its ISRC.
 */
export const sourceCopies = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    const providers = yield* Providers;
    const linked = yield* linkedProviders(principal.userId);
    const { group, cached } = yield* groupOf(sourceId);

    const playable = yield* playableSources(principal.userId, inArray(source.recordingId, group));
    const playableIds = new Set(playable.map((row) => row.source.id));
    // The other sources only need the provider and the quality
    const others = (yield* db
      .select({ source, variant: sourceVariant })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .where(inArray(source.recordingId, group))
      .groupBy(source.id)).filter((row) => !playableIds.has(row.source.id));

    const copies = [
      ...playable.map((row) => {
        const summary = sourceSummary(row);
        return new SourceCopy({
          // The edition of this copy, which the canonical album can hide
          source: new SourceSummary({ ...summary, album: row.source.rawAlbum ?? summary.album }),
          lossless: row.variant.lossless,
          bitrate: row.variant.bitrate,
          sampleRate: row.variant.sampleRate,
          bitDepth: row.variant.bitDepth,
          unavailable: null,
        });
      }),
      ...others.map(
        (row) =>
          new SourceCopy({
            source: new SourceSummary({
              id: row.source.id,
              provider: row.source.provider,
              title: row.source.rawTitle,
              artist: row.source.rawArtist,
              album: row.source.rawAlbum,
              durationMs: row.source.rawDurationMs,
              codec: row.variant.codec,
              artworkUrl: null,
              artistRef: null,
              albumRef: null,
              explicit: false,
              providerName: providers.get(row.source.provider)?.name ?? null,
              recordingId:
                row.source.recordingId === null ? null : RecordingId.make(row.source.recordingId),
            }),
            lossless: row.variant.lossless,
            bitrate: row.variant.bitrate,
            sampleRate: row.variant.sampleRate,
            bitDepth: row.variant.bitDepth,
            // A file of another server, or a provider that this server does not have
            unavailable:
              row.source.provider !== "local" && providers.has(row.source.provider)
                ? "account_required"
                : "unavailable",
          }),
      ),
      ...Option.toArray(cached).flatMap((item) => {
        const provider = linked.get(item.provider);
        if (provider === undefined) return [];
        return [
          new SourceCopy({
            source: cachedSummary(item, provider.name),
            lossless: item.source.lossless,
            bitrate: item.source.bitrate,
            sampleRate: null,
            bitDepth: null,
            unavailable: null,
          }),
        ];
      }),
    ];

    return copies.toSorted(compareCopies(yield* providerOrder(principal.userId)));
  });

/** The search result that a provider search found for each source, or `null` */
export class CopySearches extends Context.Service<
  CopySearches,
  Map<string, { readonly found: string | null; readonly at: number }>
>()("@dyad/server-core/CopySearches") {}

export const copySearchesLayer = Layer.sync(CopySearches, () => new Map());

// Each source costs at most one search of each provider a day
const searchLifetimeMs = 24 * 60 * 60 * 1000;
const searchTimeout = "8 seconds";

// The same first artist, the same title without version parts and with the same version words,
// and known durations within 3 seconds
const sameText = (
  a: { readonly title: string; readonly artist: string; readonly durationMs: number },
  b: ProviderSource,
) =>
  b.durationMs !== null &&
  Math.abs(a.durationMs - b.durationMs) <= 3000 &&
  normalizeArtist(a.artist) !== "" &&
  normalizeArtist(a.artist) === normalizeArtist(b.artist ?? "") &&
  normalizeTitle(a.title) !== "" &&
  normalizeTitle(a.title) === normalizeTitle(b.title) &&
  versionWordsOf(a.title).join() === versionWordsOf(b.title).join();

/**
 * A possible match for a source that no copy plays: the first search result with the same text
 * (`sameText`), from the usable providers in the user's order. It is only a search result in the
 * provider cache. A text match does not prove the same recording, so nothing records it as
 * identity. `undefined` when no provider has one.
 */
export const searchCopy = (sourceId: string, userId: UserId, tried: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const searches = yield* CopySearches;
    const now = yield* Clock.currentTimeMillis;
    const earlier = searches.get(sourceId);
    if (earlier !== undefined && now - earlier.at < searchLifetimeMs) {
      return earlier.found === null || tried.includes(earlier.found) ? undefined : earlier.found;
    }

    const [row] = yield* playableSources(userId, eq(source.id, sourceId));
    if (row === undefined) return undefined;
    const { title, artist, durationMs } = sourceSummary(row);
    if (title === null || artist === null || durationMs === null) return undefined;
    const text = { title, artist, durationMs };

    const compare = compareSources(yield* providerOrder(userId));
    const searchable = [...(yield* usableProviders(userId))].flatMap(([id, usable]) => {
      const search = usable.provider.search;
      return search === undefined || usable.provider.links === true ? [] : [{ id, search, usable }];
    });
    const providers = searchable.toSorted(
      (a, b) =>
        compare({ provider: a.id, lossless: false }, { provider: b.id, lossless: false }) ||
        (b.usable.provider.metadataPriority ?? 0) - (a.usable.provider.metadataPriority ?? 0),
    );

    for (const { id: provider, search, usable } of providers) {
      const results = yield* search(`${artist} ${title}`, usable.credentials).pipe(
        Effect.timeout(searchTimeout),
        Effect.catchTags({
          ProviderError: (error) =>
            Effect.logWarning("Copy search failed", error.reason).pipe(Effect.as([])),
          TimeoutError: () => Effect.logWarning("Copy search timed out").pipe(Effect.as([])),
        }),
        Effect.annotateLogs("provider", provider),
      );
      const cached = yield* cacheProviderSources(
        provider,
        results.filter((item) => sameText(text, item)),
      );
      const found = cached.find((item) => !tried.includes(item.sourceId));
      if (found !== undefined) {
        searches.set(sourceId, { found: found.sourceId, at: now });
        yield* Effect.logInfo("Found a possible match").pipe(
          Effect.annotateLogs({ sourceId, match: found.sourceId, provider }),
        );
        return found.sourceId;
      }
    }
    searches.set(sourceId, { found: null, at: now });
    return undefined;
  });
