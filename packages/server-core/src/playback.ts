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
  PlaybackCapabilities,
  PlaybackPlan,
  PlaybackUnavailable,
  UserId,
} from "@dyad/domain";
import { MediaStream, encodeFlac, remuxAudio } from "@dyad/media/node";
import type { ProviderAudio, ProviderError } from "@dyad/plugin";
import { and, eq } from "drizzle-orm";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  Path,
  Redacted,
  Schema,
  Stream,
} from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { fromHex, hex } from "./ids.ts";
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
  // The device that prepared the stream. The stream route checks that it still exists, so removing
  // the device ends its URLs.
  readonly deviceId: DeviceId;
  readonly expiresAt: number;
}> {}

const grantMessage = (grant: StreamGrant) =>
  new TextEncoder().encode(
    [
      grant.sourceId,
      grant.format.container,
      grant.format.codec,
      grant.userId,
      grant.deviceId,
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
  readonly resolve: Effect.Effect<ProviderAudio, ProviderError>;
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
    readonly container: string;
    readonly codec: string;
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

    return new ProviderPlayback({
      format: new SourceFormat({ container: audioContainer(item.container), codec: item.codec }),
      demuxer: item.container,
      resolve: usable.provider.resolve(item.externalId, usable.credentials),
    });
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
    const path = yield* Path.Path;

    const row = yield* selectSource(sourceId);
    if (row === undefined) {
      const cached = yield* cachedProviderSource(sourceId);
      if (Option.isNone(cached)) return yield* new PlaybackUnavailable({ reason: "not_found" });

      const playable = yield* providerPlayback(
        {
          provider: cached.value.provider,
          externalId: cached.value.source.externalId,
          container: cached.value.source.container,
          codec: cached.value.source.codec,
        },
        userId,
      );
      const choice = yield* choosePlayback(playable.format, capabilities);

      yield* addProviderSource(cached.value);
      return { playable, choice };
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
              container: row.variant.container,
              codec: row.variant.codec,
            },
            userId,
          );
    const choice = yield* choosePlayback(playable.format, capabilities);

    return { playable, choice };
  });

export const preparePlayback = (sourceId: string, capabilities: PlaybackCapabilities) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const { choice } = yield* choosePlayableSource(sourceId, principal.userId, capabilities);

    const grant = new StreamGrant({
      sourceId,
      format: choice.format,
      userId: principal.userId,
      deviceId: principal.deviceId,
      expiresAt: (yield* Clock.currentTimeMillis) + streamLifetimeMs,
    });
    const search = new URLSearchParams({
      container: grant.format.container,
      codec: grant.format.codec,
      user: grant.userId,
      device: grant.deviceId,
      expires: String(grant.expiresAt),
      signature: yield* signGrant(grant),
    });
    return new PlaybackPlan({ format: choice.format, path: `/stream/${sourceId}?${search}` });
  });

// The provider resolves before the response starts, so that a failure gives an error status
const providerStream = <E>(
  playable: ProviderPlayback,
  sourceId: string,
  convert: (media: MediaStream) => Stream.Stream<Uint8Array, E>,
) =>
  Effect.gen(function* () {
    const audio = yield* playable.resolve;
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
          new MediaStream({ name: sourceId, bytes, format: playable.demuxer, options }),
        );
      }),
    );
  });

const unavailableStatus = { not_found: 404, unsupported_format: 406, account_required: 403 };

const StreamRequest = Schema.Struct({
  sourceId: Schema.String.check(Schema.isUUID()),
  container: AudioContainer,
  codec: AudioCodec,
  user: UserId,
  device: DeviceId,
  expires: Schema.FiniteFromString,
  signature: Schema.String,
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
      deviceId: request.device,
      expiresAt: request.expires,
    });
    const valid = yield* verifyGrant(grant, request.signature);
    const now = yield* Clock.currentTimeMillis;
    if (!valid || grant.expiresAt < now) return HttpServerResponse.empty({ status: 403 });

    const db = yield* Database;
    const [grantDevice] = yield* db
      .select({ id: device.id })
      .from(device)
      .where(and(eq(device.id, grant.deviceId), eq(device.userId, grant.userId)))
      .limit(1);
    if (grantDevice === undefined) return HttpServerResponse.empty({ status: 403 });

    // A stream URL is stateless. Recheck the selected output against the current source.
    const { playable, choice } = yield* choosePlayableSource(
      request.sourceId,
      grant.userId,
      new PlaybackCapabilities({ formats: [grant.format] }),
    );
    const contentType = contentTypes[choice.format.container];

    if (playable instanceof FilePlayback && choice.operation === "direct") {
      return yield* HttpServerResponse.file(playable.path, { contentType });
    }

    const convert = (media: string | MediaStream) =>
      choice.operation === "transcode"
        ? encodeFlac(media)
        : remuxAudio(media, choice.format.container);

    const body =
      playable instanceof FilePlayback
        ? convert(playable.path)
        : yield* providerStream(playable, request.sourceId, convert);

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
