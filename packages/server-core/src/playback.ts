import { device, libraryRoot, localFile, source, sourceVariant } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  AudioCodec,
  AudioContainer,
  AudioFormat,
  AudioQuality,
  CurrentPrincipal,
  DeviceId,
  OutputId,
  PlaybackCapabilities,
  PlaybackPlan,
  PlaybackUnavailable,
} from "@dyad/domain";
import { MediaStream, encodeFlac, remuxAudio } from "@dyad/media/node";
import { ProviderAudio, ProviderError, ProviderLink } from "@dyad/plugin";
import { eq } from "drizzle-orm";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Path,
  PlatformError,
  Redacted,
  Result,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { sourceAnalysis } from "./audio-analysis.ts";
import { fromHex, hex, variantId } from "./ids.ts";
import { MediaCache, PrefetchItem } from "./media-cache.ts";
import { Outputs } from "./outputs.ts";
import { SourceFormat, audioContainer, choosePlayback, contentTypes } from "./playback-formats.ts";
import { cachedProviderSource, cachedSummary } from "./provider-cache.ts";
import { Providers, usableProviders } from "./providers.ts";
import { CopySearches, playableCopies, searchCopy } from "./source-copies.ts";
import { addProviderSource, playableSources, sourceSummary } from "./sources.ts";
import { queueTracklistRead } from "./tracklists.ts";

const generateStreamKey = Effect.promise(() =>
  globalThis.crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]),
);

/**
 * Signs stream URLs. A player such as Sonos opens the URL without an RPC session, so the URL
 * carries its own authorization. The key changes on restart, which ends the open URLs.
 */
export class StreamKey extends Context.Service<
  StreamKey,
  Effect.Success<typeof generateStreamKey>
>()("@dyad/server-core/StreamKey") {}

export const streamKeyLayer = Layer.effect(StreamKey, generateStreamKey);

/**
 * Recent attempts by source. `resolved`: the audio of a resolve in the last minute, so
 * that the stream after a plan does not resolve again. `failed`: the time of the last failure
 * before the first byte, so that the next plan tries another copy.
 */
export class CopyAttempts extends Context.Service<
  CopyAttempts,
  {
    readonly resolved: Map<string, { readonly audio: ProviderAudio; readonly at: number }>;
    readonly failed: Map<string, number>;
  }
>()("@dyad/server-core/CopyAttempts") {}

export const copyAttemptsLayer = Layer.sync(CopyAttempts, () => ({
  resolved: new Map(),
  failed: new Map(),
}));

// Signed provider URLs stay valid for longer
const resolvedLifetimeMs = 60_000;
// A provider that refuses a source now often refuses it for some minutes
const failedLifetimeMs = 10 * 60_000;

/** Records a failure before the first byte, so that the next plan skips the source for a while */
export const markFailed = Effect.fn("markFailed")(function* (sourceId: string) {
  const { failed } = yield* CopyAttempts;
  const now = yield* Clock.currentTimeMillis;
  for (const [key, at] of failed) if (now - at > failedLifetimeMs) failed.delete(key);
  failed.set(sourceId, now);
});

// Long enough for a queue that starts the URL later. A started stream continues after expiry.
const streamLifetimeMs = 6 * 60 * 60 * 1000;

class StreamGrant extends Data.Class<{
  readonly sourceId: string;
  readonly format: AudioFormat;
  // The device that prepared the stream, or the output that plays it. The stream route checks that
  // the device still exists or that the session still holds the output.
  readonly holder: DeviceId | OutputId;
  readonly expiresAt: number;
}> {}

const grantMessage = (lines: ReadonlyArray<string | number>) =>
  new TextEncoder().encode(lines.join("\n"));

/**
 * Signs the lines of a URL grant. Each route other than `/stream` starts its lines with its own
 * prefix, so that its signatures do not work for another route.
 */
export const signGrant = Effect.fn("signGrant")(function* (lines: ReadonlyArray<string | number>) {
  const key = yield* StreamKey;
  const signature = yield* Effect.promise(() =>
    globalThis.crypto.subtle.sign("HMAC", key, grantMessage(lines)),
  );
  return hex(new Uint8Array(signature));
});

/** True when `signature` signs `lines` and the grant has not expired */
export const verifyGrant = Effect.fn("verifyGrant")(function* (
  lines: ReadonlyArray<string | number>,
  expiresAt: number,
  signature: string,
) {
  const key = yield* StreamKey;
  const valid = yield* Effect.promise(() =>
    globalThis.crypto.subtle.verify("HMAC", key, fromHex(signature), grantMessage(lines)),
  );
  return valid && expiresAt >= (yield* Clock.currentTimeMillis);
});

/** True when the device is still paired */
export const hasDevice = Effect.fn("hasDevice")(function* (deviceId: DeviceId) {
  const db = yield* Database;
  const rows = yield* db
    .select({ id: device.id })
    .from(device)
    .where(eq(device.id, deviceId))
    .limit(1);
  return rows.length > 0;
});

const grantLines = (grant: StreamGrant) => [
  grant.sourceId,
  grant.format.container,
  grant.format.codec,
  grant.holder,
  grant.expiresAt,
];

export class FilePlayback extends Data.Class<{
  readonly format: SourceFormat;
  readonly path: string;
}> {}

export class ProviderPlayback extends Data.Class<{
  readonly format: SourceFormat;
  /** FFmpeg demuxer for the resolved bytes */
  readonly demuxer: string;
  readonly provider: string;
  /** The variant that the media cache keeps the audio as, or `null` when it must not keep it */
  readonly cacheId: string | null;
  readonly resolve: Effect.Effect<ProviderAudio, ProviderError>;
  readonly keys:
    | Effect.Effect<Redacted.Redacted<ReadonlyMap<string, string>>, ProviderError>
    | undefined;
}> {}

const selectSource = Effect.fn(function* (sourceId: string) {
  const db = yield* Database;
  const [row] = yield* db
    .select({ source, variant: sourceVariant, root: libraryRoot.path, file: localFile.path })
    .from(source)
    .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
    .leftJoin(localFile, eq(localFile.sourceId, source.id))
    .leftJoin(libraryRoot, eq(libraryRoot.id, localFile.libraryRootId))
    .where(eq(source.id, sourceId))
    .limit(1);
  return row;
});

const providerPlayback = Effect.fn(function* (item: {
  readonly sourceId: string;
  readonly provider: string;
  readonly externalId: string;
  readonly kind: string;
  readonly variantId: string;
  readonly container: string;
  readonly codec: string;
  readonly encrypted: boolean;
}) {
  const providers = yield* Providers;
  if (!providers.has(item.provider)) {
    return yield* new PlaybackUnavailable({ reason: "not_found" });
  }

  const usableByUser = yield* usableProviders;
  const usable = usableByUser.get(item.provider);
  if (usable === undefined) {
    return yield* new PlaybackUnavailable({ reason: "account_required" });
  }

  const { resolved } = yield* CopyAttempts;
  const key = item.sourceId;
  const fresh = Effect.gen(function* () {
    const audio = yield* usable.provider.resolve(item.externalId, usable.credentials);
    if (!(audio instanceof ProviderLink)) return audio;

    const linked = usableByUser.get(audio.provider);
    if (linked === undefined) {
      return yield* new ProviderError({
        reason: `Cannot play the linked ${audio.provider} source`,
      });
    }
    const linkedAudio = yield* linked.provider.resolve(audio.externalId, linked.credentials);
    if (linkedAudio instanceof ProviderLink) {
      return yield* new ProviderError({ reason: "The linked source links again" });
    }
    return linkedAudio;
  });
  const resolve = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [entry, value] of resolved) {
      if (now - value.at > resolvedLifetimeMs) resolved.delete(entry);
    }
    const earlier = resolved.get(key);
    if (earlier !== undefined) return earlier.audio;
    const audio = yield* fresh;
    resolved.set(key, { audio, at: now });
    return audio;
  });

  const keys = usable.provider.keys;
  // A live source does not end. Encrypted audio on disk needs a way to get its keys again.
  const cacheable = item.kind === "stream" && (!item.encrypted || keys !== undefined);
  return new ProviderPlayback({
    format: new SourceFormat({ container: audioContainer(item.container), codec: item.codec }),
    demuxer: item.container,
    provider: item.provider,
    cacheId: cacheable ? item.variantId : null,
    resolve,
    keys: keys?.(item.externalId, usable.credentials),
  });
});

// How the user can play the source. A search result is not in the catalog yet, so it comes with
// its cached search result.
export const findPlayableSource = Effect.fn("findPlayableSource")(function* (sourceId: string) {
  const path = yield* Path.Path;

  const row = yield* selectSource(sourceId);
  if (row === undefined) {
    const cached = yield* cachedProviderSource(sourceId);
    if (Option.isNone(cached)) return yield* new PlaybackUnavailable({ reason: "not_found" });

    const playable = yield* providerPlayback({
      sourceId,
      provider: cached.value.provider,
      externalId: cached.value.source.externalId,
      kind: "stream",
      variantId: yield* variantId(sourceId),
      container: cached.value.source.container,
      codec: cached.value.source.codec,
      encrypted: cached.value.source.encrypted,
    });
    const { codec, lossless, bitrate } = cached.value.source;
    const audio = new AudioQuality({
      codec,
      lossless,
      sampleRate: null,
      bitDepth: null,
      bitrate,
    });
    return { playable, audio, searchResult: cached };
  }

  const playable =
    row.root !== null && row.file !== null
      ? new FilePlayback({
          format: new SourceFormat({
            container: audioContainer(row.variant.container),
            codec: row.variant.codec,
          }),
          path: path.join(row.root, row.file),
        })
      : yield* providerPlayback({
          sourceId,
          provider: row.source.provider,
          externalId: row.source.externalId,
          kind: row.source.kind,
          variantId: row.variant.id,
          container: row.variant.container,
          codec: row.variant.codec,
          encrypted: row.variant.encrypted,
        });
  const { codec, lossless, sampleRate, bitDepth, bitrate } = row.variant;
  const audio = new AudioQuality({ codec, lossless, sampleRate, bitDepth, bitrate });
  return { playable, audio, searchResult: Option.none() };
});

/**
 * How the user can play the source in one of the `capabilities` formats. A search result enters
 * the shared catalog here, but only when the user can play it. A possible match of `searchCopy`
 * plays from the provider cache and does not enter the catalog.
 */
export const choosePlayableSource = Effect.fn("choosePlayableSource")(function* (
  sourceId: string,
  capabilities: PlaybackCapabilities,
) {
  const { playable, audio, searchResult } = yield* findPlayableSource(sourceId);
  const choice = yield* choosePlayback(playable.format, capabilities);

  const searches = yield* CopySearches;
  const possibleMatch = [...searches.values()].some((search) => search.found === sourceId);
  if (Option.isSome(searchResult) && !possibleMatch) {
    yield* addProviderSource(searchResult.value);
  }
  yield* queueTracklistRead(sourceId);
  return { playable, audio, choice };
});

// A copy plays when it gives audio before the first byte: a file, a complete cache file or a
// resolve. A source that failed a moment ago fails again without a request.
const tryCopy = Effect.fn(
  function* (sourceId: string, capabilities: PlaybackCapabilities) {
    const { failed } = yield* CopyAttempts;
    const failedAt = failed.get(sourceId);
    if (failedAt !== undefined && (yield* Clock.currentTimeMillis) - failedAt < failedLifetimeMs) {
      return yield* new ProviderError({ reason: "The source failed a moment ago" });
    }
    const chosen = yield* choosePlayableSource(sourceId, capabilities);
    if (chosen.playable instanceof ProviderPlayback) {
      const cached = yield* cachedAudio(chosen.playable);
      if (Option.isNone(cached)) {
        yield* chosen.playable.resolve.pipe(Effect.tapError(() => markFailed(sourceId)));
      }
    }
    return { sourceId, ...chosen };
  },
  (effect, sourceId) =>
    effect.pipe(
      orDieOnDatabaseError("tryCopy"),
      Effect.tapError((error) =>
        Effect.logWarning("Cannot play a copy", error.reason).pipe(
          Effect.annotateLogs({ sourceId }),
        ),
      ),
      Effect.result,
    ),
);

/**
 * What plays for the source: the copies of its song in the order of `playableCopies`, else a
 * possible match of `searchCopy`. A `pinned` source plays first. A source of a provider without its
 * own audio, or a search result outside the catalog, comes after the copies of its song.
 */
export const choosePlayableCopy = Effect.fn("choosePlayableCopy")(function* (
  sourceId: string,
  pinned: boolean,
  capabilities: PlaybackCapabilities,
) {
  const candidates = yield* copyCandidates(sourceId, pinned);
  const failures: Array<PlaybackUnavailable | ProviderError> = [];
  for (const candidate of candidates) {
    const result = yield* tryCopy(candidate, capabilities);
    if (Result.isSuccess(result)) return { ...result.success, possibleMatch: false };
    failures.push(result.failure);
  }

  const found = yield* searchCopy(sourceId, candidates);
  if (found !== undefined) {
    const result = yield* tryCopy(found, capabilities);
    if (Result.isSuccess(result)) return { ...result.success, possibleMatch: true };
  }

  // The reason of the source itself, unless only a provider failed
  const first = failures[candidates.indexOf(sourceId)];
  return yield* new PlaybackUnavailable({
    reason: Schema.is(PlaybackUnavailable)(first) ? first.reason : "failed",
  });
});

const copyCandidates = Effect.fn(function* (sourceId: string, pinned: boolean) {
  const providers = yield* Providers;
  const [own] = yield* playableSources(eq(source.id, sourceId));
  const ownProvider =
    own?.source.provider ?? Option.getOrUndefined(yield* cachedProviderSource(sourceId))?.provider;
  const copies = (yield* playableCopies(sourceId)).map((row) => row.source.id);
  const others = copies.filter((id) => id !== sourceId);
  const linked = ownProvider !== undefined && providers.get(ownProvider)?.links === true;
  return [...new Set(pinned && !linked ? [sourceId, ...others] : [...copies, sourceId])];
});

/**
 * The copy that `choosePlayableCopy` tries first for the source, without a request: the first
 * candidate that did not fail a moment ago. `null` when that is the source itself.
 */
export const expectedCopy = Effect.fn("expectedCopy")(function* (sourceId: string) {
  const { failed } = yield* CopyAttempts;
  const now = yield* Clock.currentTimeMillis;
  const candidates = yield* copyCandidates(sourceId, false);
  const first = candidates.find((id) => {
    const failedAt = failed.get(id);
    return failedAt === undefined || now - failedAt >= failedLifetimeMs;
  });
  return first === undefined ? null : yield* copySummary(sourceId, first);
});

// The source that plays, when it is not the requested source
const copySummary = Effect.fn(function* (sourceId: string, copyId: string) {
  if (copyId === sourceId) return null;
  const [row] = yield* playableSources(eq(source.id, copyId));
  if (row !== undefined) return sourceSummary(row);
  const cached = yield* cachedProviderSource(copyId);
  if (Option.isNone(cached)) return null;
  const provider = (yield* Providers).get(cached.value.provider);
  return yield* cachedSummary(cached.value, provider?.name ?? cached.value.provider);
});

/**
 * A signed stream URL for `holder`, of the source or of the copy that plays for it. It stops
 * working when the device is removed, or when the session no longer holds the output.
 */
export const streamPlan = Effect.fn("streamPlan")(function* (
  requestedId: string,
  pinned: boolean,
  holder: DeviceId | OutputId,
  capabilities: PlaybackCapabilities,
) {
  const { sourceId, audio, choice, possibleMatch } = yield* choosePlayableCopy(
    requestedId,
    pinned,
    capabilities,
  );

  const grant = new StreamGrant({
    sourceId,
    format: choice.format,
    holder,
    expiresAt: (yield* Clock.currentTimeMillis) + streamLifetimeMs,
  });
  const search = new URLSearchParams({
    container: grant.format.container,
    codec: grant.format.codec,
    holder: grant.holder,
    expires: String(grant.expiresAt),
    signature: yield* signGrant(grantLines(grant)),
  });
  return new PlaybackPlan({
    format: choice.format,
    path: `/stream/${sourceId}?${search}`,
    analysis: yield* sourceAnalysis(sourceId),
    source: audio,
    copy: yield* copySummary(requestedId, sourceId),
    possibleMatch,
  });
});

export const preparePlayback = Effect.fn("preparePlayback")(function* (
  sourceId: string,
  pinned: boolean,
  capabilities: PlaybackCapabilities,
) {
  const principal = yield* CurrentPrincipal;
  return yield* streamPlan(sourceId, pinned, principal.deviceId, capabilities);
});

class SourceAudio extends Data.Class<{
  readonly bytes: Stream.Stream<Uint8Array, ProviderError | PlatformError.PlatformError>;
  readonly decryptionKeys: Redacted.Redacted<ReadonlyMap<string, string>> | undefined;
  /** The bytes start inside the source */
  readonly partial: boolean;
}> {}

// Cached audio plays only with the keys of the asset in the file. Keys of another asset, for
// example after the provider replaced the song's file, make it a cache miss.
const cachedAudio = Effect.fn(function* (playable: ProviderPlayback) {
  const cache = yield* MediaCache;
  if (playable.cacheId === null) return Option.none();

  const file = yield* cache.find(playable.cacheId);
  if (Option.isNone(file)) return Option.none();

  const bytes = cache.read(file.value);
  if (file.value.keyIds.length === 0) {
    return Option.some(new SourceAudio({ bytes, decryptionKeys: undefined, partial: false }));
  }
  if (playable.keys === undefined) return Option.none();

  const decryptionKeys = yield* playable.keys;
  const keys = Redacted.value(decryptionKeys);
  if (!file.value.keyIds.every((keyId) => keys.has(keyId))) return Option.none();
  yield* cache.decrypted(file.value, decryptionKeys);
  return Option.some(new SourceAudio({ bytes, decryptionKeys, partial: false }));
});

// Decoders need the packets before the start, see `isEnoughPreroll` in `@dyad/media`
const prerollMs = 1000;

// The provider resolves before the response starts, so that a failure gives an error status
export const providerStream = Effect.fn("providerStream")(function* <E>(
  playable: ProviderPlayback,
  sourceId: string,
  startMs: number,
  convert: (media: MediaStream) => Stream.Stream<Uint8Array, E>,
) {
  const cache = yield* MediaCache;
  const cached = yield* cachedAudio(playable);
  const audio = Option.isSome(cached)
    ? cached.value
    : yield* Effect.map(playable.resolve, (resolved) => {
        // The cache keeps only complete files
        const from = startMs > 0 ? resolved.bytesFrom : undefined;
        return new SourceAudio({
          bytes:
            from === undefined
              ? cache.download(playable.provider, playable.cacheId, resolved)
              : cache.download(
                  playable.provider,
                  null,
                  new ProviderAudio({ bytes: from(Math.max(0, startMs - prerollMs)) }),
                ),
          decryptionKeys: resolved.decryptionKeys,
          partial: from !== undefined,
        });
      });
  return convert(
    new MediaStream({
      name: sourceId,
      bytes: audio.bytes,
      format: playable.demuxer,
      decryptionKeys: audio.decryptionKeys,
      partial: audio.partial,
    }),
  );
});

/**
 * Replaces the hint of `session` with the sources that it plays next. The media cache downloads
 * them. It skips sources that the user cannot play and sources that it does not keep.
 */
export const hintPrefetch = Effect.fn("hintPrefetch")(function* (
  session: string,
  sourceIds: ReadonlyArray<string>,
) {
  const cache = yield* MediaCache;

  const items = yield* Effect.forEach(sourceIds, (sourceId) =>
    findPlayableSource(sourceId).pipe(
      Effect.map(({ playable }) =>
        playable instanceof ProviderPlayback && playable.cacheId !== null
          ? [
              new PrefetchItem({
                variantId: playable.cacheId,
                provider: playable.provider,
                resolve: playable.resolve,
              }),
            ]
          : [],
      ),
      Effect.catchTag("PlaybackUnavailable", () => Effect.succeed([])),
    ),
  );
  yield* cache.hint(session, items.flat());
});

export const unavailableStatus = {
  not_found: 404,
  unsupported_format: 406,
  account_required: 403,
  failed: 502,
};

const StreamRequest = Schema.Struct({
  sourceId: Schema.String.check(Schema.isUUID()),
  container: AudioContainer,
  codec: AudioCodec,
  holder: Schema.Union([DeviceId, OutputId]),
  expires: Schema.FiniteFromString,
  signature: Schema.String,
  // Not in the signature: any start of a granted stream is allowed
  start: Schema.optionalKey(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

// Not `GET`: the catch-all route of the web application would take `HEAD`, which Sonos sends
export const streamRoute = HttpRouter.add(
  "*",
  "/stream/:sourceId",
  Effect.gen(function* () {
    const { method } = yield* HttpServerRequest.HttpServerRequest;
    if (method !== "GET" && method !== "HEAD") return HttpServerResponse.empty({ status: 405 });
    const request = yield* HttpRouter.schemaParams(StreamRequest);
    const grant = new StreamGrant({
      sourceId: request.sourceId,
      format: new AudioFormat({ container: request.container, codec: request.codec }),
      holder: request.holder,
      expiresAt: request.expires,
    });
    if (!(yield* verifyGrant(grantLines(grant), grant.expiresAt, request.signature))) {
      return HttpServerResponse.empty({ status: 403 });
    }
    const holds = Schema.is(DeviceId)(grant.holder)
      ? yield* hasDevice(grant.holder)
      : (yield* Outputs).isHeld(grant.holder);
    if (!holds) return HttpServerResponse.empty({ status: 403 });

    // A stream URL is stateless. Recheck the selected output against the current source.
    const { playable, choice } = yield* choosePlayableSource(
      request.sourceId,
      new PlaybackCapabilities({ formats: [grant.format] }),
    );
    const contentType = contentTypes[choice.format.container];
    const startMs = request.start ?? 0;

    if (playable instanceof FilePlayback && choice.operation === "direct" && startMs === 0) {
      return yield* HttpServerResponse.file(playable.path, { contentType });
    }
    // The headers of the stream, without a provider request
    if (method === "HEAD") return HttpServerResponse.stream(Stream.empty, { contentType });

    // An MP3 or ADTS remux cannot cut inside a frame. FLAC encodes without loss, so FLAC output
    // with a start always encodes and starts at the exact sample.
    const convert = (media: string | MediaStream) =>
      choice.operation === "transcode" || (startMs > 0 && choice.format.container === "flac")
        ? encodeFlac(media, startMs)
        : remuxAudio(media, choice.format.container, startMs);

    const failed = markFailed(request.sourceId).pipe(
      Effect.provideService(CopyAttempts, yield* CopyAttempts),
    );
    const body =
      playable instanceof FilePlayback
        ? convert(playable.path)
        : yield* providerStream(playable, request.sourceId, startMs, convert).pipe(
            Effect.tapError((error) => (error instanceof ProviderError ? failed : Effect.void)),
          );

    // A stream that fails before its first byte, for example after a refused media URL, makes
    // the next plan try another source
    const progress = { started: false };
    return HttpServerResponse.stream(
      body.pipe(
        Stream.tap(() => Effect.sync(() => (progress.started = true))),
        // The error text can contain provider URLs or key material, so only its name is logged
        Stream.tapError((error) =>
          Effect.logError("Playback stream failed").pipe(
            Effect.annotateLogs({
              sourceId: request.sourceId,
              operation: choice.operation,
              error: error.name,
            }),
            Effect.andThen(Effect.suspend(() => (progress.started ? Effect.void : failed))),
          ),
        ),
      ),
      { contentType },
    );
  }).pipe(
    orDieOnDatabaseError("stream"),
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      PlaybackUnavailable: (error) =>
        Effect.succeed(HttpServerResponse.empty({ status: unavailableStatus[error.reason] })),
      ProviderError: (error) =>
        Effect.logError("Cannot resolve the source", error.reason).pipe(
          Effect.as(HttpServerResponse.empty({ status: 502 })),
        ),
    }),
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
  ),
);
