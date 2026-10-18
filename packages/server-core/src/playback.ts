// @effect-diagnostics-next-line nodeBuiltinImport:off -- FFmpeg reads provider bytes from a Node stream
import { Readable } from "node:stream";

import { device, libraryRoot, localFile, source, sourceVariant } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  AudioCodec,
  AudioContainer,
  AudioFormat,
  CurrentPrincipal,
  DeviceId,
  OutputId,
  PlaybackCapabilities,
  PlaybackPlan,
  PlaybackUnavailable,
  UserId,
} from "@dyad/domain";
import { MediaStream, encodeFlac, remuxAudio } from "@dyad/media/node";
import { ProviderAudio } from "@dyad/plugin";
import type { ProviderError } from "@dyad/plugin";
import { and, eq } from "drizzle-orm";
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
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { sourceAnalysis } from "./audio-analysis.ts";
import { fromHex, hex, variantId } from "./ids.ts";
import { MediaCache, PrefetchItem } from "./media-cache.ts";
import { Outputs } from "./outputs.ts";
import { SourceFormat, audioContainer, choosePlayback, contentTypes } from "./playback-formats.ts";
import { cachedProviderSource } from "./provider-cache.ts";
import { Providers, usableProviders } from "./providers.ts";
import { addProviderSource } from "./sources.ts";

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

// Long enough for a queue that starts the URL later. A started stream continues after expiry.
const streamLifetimeMs = 6 * 60 * 60 * 1000;

class StreamGrant extends Data.Class<{
  readonly sourceId: string;
  readonly format: AudioFormat;
  readonly userId: UserId;
  // The device that prepared the stream, or the output that plays it. The stream route checks that
  // the device still exists or that the user's session still holds the output.
  readonly holder: DeviceId | OutputId;
  readonly expiresAt: number;
}> {}

const grantMessage = (grant: StreamGrant) =>
  new TextEncoder().encode(
    [
      grant.sourceId,
      grant.format.container,
      grant.format.codec,
      grant.userId,
      grant.holder,
      grant.expiresAt,
    ].join("\n"),
  );

const signGrant = (grant: StreamGrant) =>
  Effect.gen(function* () {
    const key = yield* StreamKey;
    const signature = yield* Effect.promise(() =>
      globalThis.crypto.subtle.sign("HMAC", key, grantMessage(grant)),
    );
    return hex(new Uint8Array(signature));
  });

const verifyGrant = (grant: StreamGrant, signature: string) =>
  Effect.gen(function* () {
    const key = yield* StreamKey;
    return yield* Effect.promise(() =>
      globalThis.crypto.subtle.verify("HMAC", key, fromHex(signature), grantMessage(grant)),
    );
  });

class FilePlayback extends Data.Class<{
  readonly format: SourceFormat;
  readonly path: string;
}> {}

class ProviderPlayback extends Data.Class<{
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

const selectSource = (sourceId: string) =>
  Effect.gen(function* () {
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

const providerPlayback = (
  item: {
    readonly provider: string;
    readonly externalId: string;
    readonly kind: string;
    readonly variantId: string;
    readonly container: string;
    readonly codec: string;
    readonly encrypted: boolean;
  },
  userId: UserId,
) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    if (!providers.has(item.provider)) {
      return yield* new PlaybackUnavailable({ reason: "not_found" });
    }

    const usable = (yield* usableProviders(userId)).get(item.provider);
    if (usable === undefined) {
      return yield* new PlaybackUnavailable({ reason: "account_required" });
    }

    const keys = usable.provider.keys;
    // A live source does not end. Encrypted audio on disk needs a way to get its keys again.
    const cacheable = item.kind === "stream" && (!item.encrypted || keys !== undefined);
    return new ProviderPlayback({
      format: new SourceFormat({ container: audioContainer(item.container), codec: item.codec }),
      demuxer: item.container,
      provider: item.provider,
      cacheId: cacheable ? item.variantId : null,
      resolve: usable.provider.resolve(item.externalId, usable.credentials),
      keys: keys?.(item.externalId, usable.credentials),
    });
  });

// How the user can play the source. A search result is not in the catalog yet, so it comes with
// its cached search result.
const findPlayableSource = (sourceId: string, userId: UserId) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;

    const row = yield* selectSource(sourceId);
    if (row === undefined) {
      const cached = yield* cachedProviderSource(sourceId);
      if (Option.isNone(cached)) return yield* new PlaybackUnavailable({ reason: "not_found" });

      const playable = yield* providerPlayback(
        {
          provider: cached.value.provider,
          externalId: cached.value.source.externalId,
          kind: "stream",
          variantId: yield* variantId(sourceId),
          container: cached.value.source.container,
          codec: cached.value.source.codec,
          encrypted: cached.value.source.encrypted,
        },
        userId,
      );
      return { playable, searchResult: cached };
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
        : yield* providerPlayback(
            {
              provider: row.source.provider,
              externalId: row.source.externalId,
              kind: row.source.kind,
              variantId: row.variant.id,
              container: row.variant.container,
              codec: row.variant.codec,
              encrypted: row.variant.encrypted,
            },
            userId,
          );
    return { playable, searchResult: Option.none() };
  });

/**
 * How the user can play the source in one of the `capabilities` formats. A search result enters
 * the shared catalog here, but only when the user can play it.
 */
const choosePlayableSource = (
  sourceId: string,
  userId: UserId,
  capabilities: PlaybackCapabilities,
) =>
  Effect.gen(function* () {
    const { playable, searchResult } = yield* findPlayableSource(sourceId, userId);
    const choice = yield* choosePlayback(playable.format, capabilities);

    if (Option.isSome(searchResult)) yield* addProviderSource(searchResult.value);
    return { playable, choice };
  });

/**
 * A signed stream URL for `holder`. It stops working when the device is removed, or when the
 * user's session no longer holds the output.
 */
export const streamPlan = (
  sourceId: string,
  userId: UserId,
  holder: DeviceId | OutputId,
  capabilities: PlaybackCapabilities,
) =>
  Effect.gen(function* () {
    const { choice } = yield* choosePlayableSource(sourceId, userId, capabilities);

    const grant = new StreamGrant({
      sourceId,
      format: choice.format,
      userId,
      holder,
      expiresAt: (yield* Clock.currentTimeMillis) + streamLifetimeMs,
    });
    const search = new URLSearchParams({
      container: grant.format.container,
      codec: grant.format.codec,
      user: grant.userId,
      holder: grant.holder,
      expires: String(grant.expiresAt),
      signature: yield* signGrant(grant),
    });
    return new PlaybackPlan({
      format: choice.format,
      path: `/stream/${sourceId}?${search}`,
      analysis: yield* sourceAnalysis(sourceId),
    });
  });

export const preparePlayback = (sourceId: string, capabilities: PlaybackCapabilities) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    return yield* streamPlan(sourceId, principal.userId, principal.deviceId, capabilities);
  });

class SourceAudio extends Data.Class<{
  readonly bytes: Stream.Stream<Uint8Array, ProviderError | PlatformError.PlatformError>;
  readonly decryptionKeys: Redacted.Redacted<ReadonlyMap<string, string>> | undefined;
  /** The bytes start inside the source */
  readonly partial: boolean;
}> {}

// Cached audio plays only with the keys of the asset in the file. Keys of another asset, for
// example after the provider replaced the song's file, make it a cache miss.
const cachedAudio = (playable: ProviderPlayback) =>
  Effect.gen(function* () {
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
const providerStream = <E>(
  playable: ProviderPlayback,
  sourceId: string,
  startMs: number,
  convert: (media: MediaStream) => Stream.Stream<Uint8Array, E>,
) =>
  Effect.gen(function* () {
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
    // FFmpeg's `decryption_keys` dictionary is `<kid>=<key>` pairs, separated by `:`
    const keys =
      audio.decryptionKeys === undefined ? [] : [...Redacted.value(audio.decryptionKeys)];
    const options =
      keys.length === 0
        ? {}
        : {
            decryption_keys: Redacted.make(keys.map(([kid, key]) => `${kid}=${key}`).join(":")),
          };

    return Stream.unwrap(
      Effect.gen(function* () {
        // `node-av` 6.1.1 does not close a `Readable` input. Destroying it stops the download.
        const bytes = yield* Effect.acquireRelease(
          Effect.sync(() => Readable.fromWeb(Stream.toReadableStream(audio.bytes))),
          (bytes) => Effect.sync(() => bytes.destroy()),
        );
        return convert(
          new MediaStream({
            name: sourceId,
            bytes,
            format: playable.demuxer,
            options,
            partial: audio.partial,
          }),
        );
      }),
    );
  });

/**
 * Replaces the hint of `session` with the sources that it plays next. The media cache downloads
 * them. It skips sources that the user cannot play and sources that it does not keep.
 */
export const hintPrefetch = (session: string, userId: UserId, sourceIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const cache = yield* MediaCache;

    const items = yield* Effect.forEach(sourceIds, (sourceId) =>
      findPlayableSource(sourceId, userId).pipe(
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

const unavailableStatus = { not_found: 404, unsupported_format: 406, account_required: 403 };

const StreamRequest = Schema.Struct({
  sourceId: Schema.String.check(Schema.isUUID()),
  container: AudioContainer,
  codec: AudioCodec,
  user: UserId,
  holder: Schema.Union([DeviceId, OutputId]),
  expires: Schema.FiniteFromString,
  signature: Schema.String,
  // Not in the signature: any start of a granted stream is allowed
  start: Schema.optionalKey(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

export const streamRoute = HttpRouter.add(
  "GET",
  "/stream/:sourceId",
  Effect.gen(function* () {
    const request = yield* HttpRouter.schemaParams(StreamRequest);
    const grant = new StreamGrant({
      sourceId: request.sourceId,
      format: new AudioFormat({ container: request.container, codec: request.codec }),
      userId: request.user,
      holder: request.holder,
      expiresAt: request.expires,
    });
    const valid = yield* verifyGrant(grant, request.signature);
    const now = yield* Clock.currentTimeMillis;
    if (!valid || grant.expiresAt < now) return HttpServerResponse.empty({ status: 403 });

    const db = yield* Database;
    const holds = Schema.is(DeviceId)(grant.holder)
      ? yield* db
          .select({ id: device.id })
          .from(device)
          .where(and(eq(device.id, grant.holder), eq(device.userId, grant.userId)))
          .limit(1)
          .pipe(Effect.map((rows) => rows.length > 0))
      : (yield* Outputs).heldBy(grant.holder) === grant.userId;
    if (!holds) return HttpServerResponse.empty({ status: 403 });

    // A stream URL is stateless. Recheck the selected output against the current source.
    const { playable, choice } = yield* choosePlayableSource(
      request.sourceId,
      grant.userId,
      new PlaybackCapabilities({ formats: [grant.format] }),
    );
    const contentType = contentTypes[choice.format.container];
    const startMs = request.start ?? 0;

    if (playable instanceof FilePlayback && choice.operation === "direct" && startMs === 0) {
      return yield* HttpServerResponse.file(playable.path, { contentType });
    }

    // An MP3 or ADTS remux cannot cut inside a frame. FLAC encodes without loss, so FLAC output
    // with a start always encodes and starts at the exact sample.
    const convert = (media: string | MediaStream) =>
      choice.operation === "transcode" || (startMs > 0 && choice.format.container === "flac")
        ? encodeFlac(media, startMs)
        : remuxAudio(media, choice.format.container, startMs);

    const body =
      playable instanceof FilePlayback
        ? convert(playable.path)
        : yield* providerStream(playable, request.sourceId, startMs, convert);

    return HttpServerResponse.stream(
      body.pipe(
        // The error text can contain provider URLs or key material, so only its name is logged
        Stream.tapError((error) =>
          Effect.logError("Playback stream failed").pipe(
            Effect.annotateLogs({
              sourceId: request.sourceId,
              operation: choice.operation,
              error: error.name,
            }),
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
