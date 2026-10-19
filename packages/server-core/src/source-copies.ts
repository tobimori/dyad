import { artist, providerItem, recording, source, sourceVariant } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  RecordingId,
  SourceCopies,
  SourceCopy,
  SourceSummary,
  compareCopies,
  compareSources,
} from "@dyad/domain";
import { ProviderSource } from "@dyad/plugin";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { Clock, Context, Effect, Layer, Option, Schema, Stream } from "effect";

import { artistIdOf } from "./artists.ts";
import { isrcRecordingId } from "./ids.ts";
import { Jobs } from "./jobs.ts";
import { fitsDuration, rootRank, songCandidates, songFacts, songTitleKey } from "./matching.ts";
import { MediaCache } from "./media-cache.ts";
import { normalizeArtist, normalizeTitle } from "./normalize.ts";
import {
  cacheProviderSources,
  cachedArtistId,
  cachedProviderSource,
  cachedSummary,
  toCachedSource,
} from "./provider-cache.ts";
import type { CachedSource } from "./provider-cache.ts";
import { Providers, callProvider, linkedProviders, usableProviders } from "./providers.ts";
import { recordingGroup } from "./sets.ts";
import { providerOrder } from "./source-preference.ts";
import { versionWordsOf } from "./ranking.ts";
import { playableSources, sourceSummary } from "./sources.ts";

// The root of an artist ID of a provider
const artistRoot = Effect.fn(function* (provider: string, externalId: string) {
  const db = yield* Database;
  const id = yield* artistIdOf(provider, externalId);
  const [row] = yield* db
    .select({ mergedIntoId: artist.mergedIntoId })
    .from(artist)
    .where(eq(artist.id, id));
  return row?.mergedIntoId ?? id;
});

// The song of a cached result for the `artist_title` rule
const cachedSongFacts = Effect.fn(function* (item: CachedSource) {
  const artistId = yield* cachedArtistId(item);
  const { title } = yield* cachedSummary(item, item.provider);
  const { durationMs } = item.source;
  if (artistId === null || title === null || durationMs === null) return null;
  const titleKey = songTitleKey(title);
  if (titleKey === "") return null;
  return { title, titleKey, durationMs, artistRoot: yield* artistRoot(item.provider, artistId) };
});

const digraphs = new Map([
  ["ä", "ae"],
  ["ö", "oe"],
  ["ü", "ue"],
  ["Ä", "Ae"],
  ["Ö", "Oe"],
  ["Ü", "Ue"],
  ["ß", "ss"],
]);

// The cached results of the song by the `artist_title` rule
const cachedCopies = Effect.fn(function* (
  facts: NonNullable<Effect.Success<ReturnType<typeof cachedSongFacts>>>,
) {
  const db = yield* Database;
  // The title before its brackets narrows the scan; the rule decides
  const base = facts.title.split(/[([]/u)[0]?.trim() ?? "";
  if (base === "") return [];
  // The spellings with umlauts, with `ae` and without both
  const spellings = new Set([
    base,
    base.replaceAll(/[äöüÄÖÜß]/gu, (letter) => digraphs.get(letter) ?? letter),
    base.replaceAll(/([aou])e/giu, "$1\u0308").normalize("NFC"),
    base
      .normalize("NFD")
      .replaceAll("\u0308", "")
      .replaceAll(/([aou])e/giu, "$1")
      .replaceAll("ß", "ss")
      .normalize("NFC"),
  ]);
  const rows = yield* db
    .select({ provider: providerItem.provider, data: providerItem.data })
    .from(providerItem)
    .where(
      or(
        ...[...spellings].map(
          (spelling) =>
            sql`json_extract(${providerItem.data}, '$.title') like ${`%${spelling.replaceAll(/[\\%_]/g, "\\$&")}%`} escape '\\'`,
        ),
      ),
    );
  const items = yield* Effect.forEach(rows, (row) =>
    Option.match(Schema.decodeUnknownOption(ProviderSource)(row.data), {
      onNone: () => Effect.succeed([]),
      onSome: (decoded) => toCachedSource(row.provider, decoded).pipe(Effect.map((item) => [item])),
    }),
  );
  return yield* Effect.filter(items.flat(), (item) =>
    cachedSongFacts(item).pipe(
      Effect.map(
        (found) =>
          found !== null &&
          found.artistRoot === facts.artistRoot &&
          found.titleKey === facts.titleKey &&
          fitsDuration(found.durationMs, facts.durationMs),
      ),
    ),
  );
});

// The recordings of the canonical recording of the source, and the cached results of the same
// song. A search result that is not in the catalog finds its group through its ISRC, else through
// the `artist_title` rule.
const groupOf = Effect.fn(function* (sourceId: string) {
  const db = yield* Database;
  const [own] = yield* db
    .select({ recordingId: source.recordingId })
    .from(source)
    .where(eq(source.id, sourceId));
  const cached = own === undefined ? yield* cachedProviderSource(sourceId) : Option.none();
  const facts =
    own?.recordingId == null
      ? yield* Option.match(cached, {
          onNone: () => Effect.succeed(null),
          onSome: cachedSongFacts,
        })
      : yield* songFacts(own.recordingId);
  const isrc = Option.getOrNull(cached)?.isrc ?? null;
  const byRule =
    facts === null || Option.isNone(cached)
      ? undefined
      : (yield* songCandidates(cached.value.recordingId, facts)).toSorted(
          (a, b) => rootRank(a.rootOrigin) - rootRank(b.rootOrigin) || a.root.localeCompare(b.root),
        )[0]?.root;
  const starts =
    own?.recordingId ?? (isrc === null ? (byRule ?? null) : yield* isrcRecordingId(isrc));
  const group = starts === null ? [] : yield* recordingGroup(starts);
  const sameSong = facts === null ? [] : yield* cachedCopies(facts);
  return { group, cached, sameSong };
});

/**
 * The other sources of the recording that the user can play, best first: the user's provider
 * order, then a local file, then a stream in the media cache, then quality
 */
export const playableCopies = Effect.fn("playableCopies")(function* (sourceId: string) {
  const cache = yield* MediaCache;
  const { group } = yield* groupOf(sourceId);
  if (group.length === 0) return [];
  const rows = yield* playableSources(
    and(inArray(source.recordingId, group), ne(source.id, sourceId)),
  );
  const cached = new Set(
    yield* Effect.filter(rows, (row) => Effect.map(cache.find(row.variant.id), Option.isSome)),
  );
  const compare = compareSources(yield* providerOrder);
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
export const sourceCopies = Effect.fn("sourceCopies")(function* (sourceId: string) {
  const db = yield* Database;
  const providers = yield* Providers;
  const linked = yield* linkedProviders;
  const { group, cached, sameSong } = yield* groupOf(sourceId);

  const playable = yield* playableSources(inArray(source.recordingId, group));
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
    ...(yield* Effect.forEach(
      [
        ...Option.toArray(cached),
        // Results of the same song that no copy of the group already is
        ...sameSong.filter(
          (item) =>
            item.sourceId !== sourceId &&
            !playableIds.has(item.sourceId) &&
            !others.some((row) => row.source.id === item.sourceId),
        ),
      ],
      (item) =>
        Effect.gen(function* () {
          const provider = linked.get(item.provider);
          if (provider === undefined) return [];
          return [
            new SourceCopy({
              source: yield* cachedSummary(item, provider.name),
              lossless: item.source.lossless,
              bitrate: item.source.bitrate,
              sampleRate: null,
              bitDepth: null,
              unavailable: null,
            }),
          ];
        }),
    )).flat(),
  ];

  return copies.toSorted(compareCopies(yield* providerOrder));
});

/** When each provider was last searched for the copies of each source */
export class CopyDiscoveries extends Context.Service<CopyDiscoveries, Map<string, number>>()(
  "@dyad/server-core/CopyDiscoveries",
) {}

export const copyDiscoveriesLayer = Layer.sync(CopyDiscoveries, () => new Map());

// The artist and title that a provider search for the song uses
const songText = Effect.fn(function* (sourceId: string) {
  const db = yield* Database;
  const [own] = yield* db
    .select({ title: recording.title, artist: recording.artistName })
    .from(source)
    .innerJoin(recording, eq(recording.id, source.recordingId))
    .where(eq(source.id, sourceId));
  if (own !== undefined) return own;
  const cached = yield* cachedProviderSource(sourceId);
  if (Option.isNone(cached)) return null;
  const summary = yield* cachedSummary(cached.value, cached.value.provider);
  return { title: summary.title, artist: summary.artist };
});

// The usable providers with search that were not searched for the song in the last day. In the
// background, only providers that allow requests without a user action.
const discoveryTargets = Effect.fn(function* (sourceId: string, background: boolean) {
  const discoveries = yield* CopyDiscoveries;
  const now = yield* Clock.currentTimeMillis;
  return [...(yield* usableProviders)].flatMap(([id, usable]) => {
    const { search, userRequestsOnly } = usable.provider;
    const at = discoveries.get(`${sourceId}:${id}`);
    if (search === undefined || (at !== undefined && now - at < searchLifetimeMs)) return [];
    if (background && userRequestsOnly === true) return [];
    return [{ id, search, credentials: usable.credentials }];
  });
});

// Searches each target for the song and keeps the results in the provider cache
const discover = Effect.fn(function* (
  sourceId: string,
  query: string,
  targets: Effect.Success<ReturnType<typeof discoveryTargets>>,
) {
  const discoveries = yield* CopyDiscoveries;
  const now = yield* Clock.currentTimeMillis;
  yield* Effect.forEach(
    targets,
    ({ id, search, credentials }) =>
      Effect.gen(function* () {
        const results = yield* callProvider(
          "Copy discovery",
          searchTimeout,
          search(query, credentials),
        );
        if (Option.isNone(results)) return;
        yield* cacheProviderSources(id, results.value);
        discoveries.set(`${sourceId}:${id}`, now);
      }).pipe(Effect.annotateLogs("provider", id)),
    { concurrency: "unbounded", discard: true },
  );
});

const songQuery = (
  text: { readonly title: string | null; readonly artist: string | null } | null,
) =>
  text?.title == null ? null : [text.artist, text.title].filter((part) => part != null).join(" ");

const discoveryKind = "copies.discover";
const DiscoveryPayload = Schema.Struct({ sourceId: Schema.String });

/** Finds the copies of the songs on the providers in the background, for example of the next songs */
export const queueCopyDiscovery = Effect.fn("queueCopyDiscovery")(function* (
  sourceIds: Iterable<string>,
) {
  const jobs = yield* Jobs;
  yield* Effect.forEach(
    new Set(sourceIds),
    (sourceId) => jobs.enqueue(discoveryKind, sourceId, { sourceId }, { priority: -2 }),
    { discard: true },
  );
});

export const copyDiscoveryLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    yield* jobs.register(
      discoveryKind,
      DiscoveryPayload,
      ({ sourceId }) =>
        Effect.gen(function* () {
          const targets = yield* discoveryTargets(sourceId, true);
          const query = targets.length === 0 ? null : songQuery(yield* songText(sourceId));
          if (query !== null) yield* discover(sourceId, query, targets);
        }).pipe(orDieOnDatabaseError("copyDiscovery")),
      { homeOnly: true },
    );
  }),
);

/**
 * All copies of the song: the known copies first, then, after a search of each provider for the
 * song, the copies again with the results that the `artist_title` rule accepts
 */
export const sourceCopiesStream = (sourceId: string) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const targets = yield* discoveryTargets(sourceId, false);
      const query = targets.length === 0 ? null : songQuery(yield* songText(sourceId));
      const first = new SourceCopies({
        copies: yield* sourceCopies(sourceId),
        searching: query !== null,
      });
      if (query === null) return Stream.succeed(first);

      return Stream.concat(
        Stream.succeed(first),
        Stream.fromEffect(
          discover(sourceId, query, targets).pipe(
            Effect.andThen(sourceCopies(sourceId)),
            Effect.map((copies) => new SourceCopies({ copies, searching: false })),
          ),
        ),
      );
    }),
  );

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
export const searchCopy = Effect.fn("searchCopy")(function* (
  sourceId: string,
  tried: ReadonlyArray<string>,
) {
  const searches = yield* CopySearches;
  const now = yield* Clock.currentTimeMillis;
  const earlier = searches.get(sourceId);
  if (earlier !== undefined && now - earlier.at < searchLifetimeMs) {
    return earlier.found === null || tried.includes(earlier.found) ? undefined : earlier.found;
  }

  const [row] = yield* playableSources(eq(source.id, sourceId));
  if (row === undefined) return undefined;
  const { title, artist, durationMs } = sourceSummary(row);
  if (title === null || artist === null || durationMs === null) return undefined;
  const text = { title, artist, durationMs };

  const compare = compareSources(yield* providerOrder);
  const searchable = [...(yield* usableProviders)].flatMap(([id, usable]) => {
    const search = usable.provider.search;
    return search === undefined || usable.provider.links === true ? [] : [{ id, search, usable }];
  });
  const providers = searchable.toSorted(
    (a, b) =>
      compare({ provider: a.id, lossless: false }, { provider: b.id, lossless: false }) ||
      (b.usable.provider.metadataPriority ?? 0) - (a.usable.provider.metadataPriority ?? 0),
  );

  for (const { id: provider, search, usable } of providers) {
    const results = Option.getOrElse(
      yield* callProvider(
        "Copy search",
        searchTimeout,
        search(`${artist} ${title}`, usable.credentials),
      ).pipe(Effect.annotateLogs("provider", provider)),
      () => [],
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
