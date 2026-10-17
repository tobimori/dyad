// @effect-diagnostics-next-line nodeBuiltinImport:off -- FFmpeg reads provider bytes from a Node stream
import { Readable } from "node:stream";

import { libraryRoot, localFile, source, sourceVariant } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  AudioCodec,
  AudioContainer,
  AudioFormat,
  CurrentPrincipal,
  PlaybackCapabilities,
  PlaybackPlan,
  PlaybackUnavailable,
  UserId,
} from "@dyad/domain";
import { MediaStream, encodeFlac, remuxAudio } from "@dyad/media/node";
import type { ProviderAudio, Resolve, ResolveError } from "@dyad/plugin";
import { eq } from "drizzle-orm";
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

import { loadCredentials } from "./accounts.ts";
import { fromHex, hex } from "./auth.ts";
import { audioContainer, choosePlayback, contentTypes } from "./playback-formats.ts";

/** Resolvers that plugins add, by provider name */
export class SourceResolvers extends Context.Service<SourceResolvers, Map<string, Resolve>>()(
  "@dyad/server-core/SourceResolvers",
) {}

export const sourceResolversLayer = Layer.sync(SourceResolvers, () => new Map());

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
  readonly expiresAt: number;
}> {}

const grantMessage = (grant: StreamGrant) =>
  new TextEncoder().encode(
    [
      grant.sourceId,
      grant.format.container,
      grant.format.codec,
      grant.userId,
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
  readonly format: { readonly container: string; readonly codec: string };
  readonly path: string;
}> {}

class ProviderPlayback extends Data.Class<{
  readonly format: { readonly container: string; readonly codec: string };
  /** FFmpeg demuxer for the resolved bytes */
  readonly demuxer: string;
  readonly resolve: Effect.Effect<ProviderAudio, ResolveError>;
}> {}

// A file on this replica plays before a provider stream of the same source
const playableSource = (sourceId: string, userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const path = yield* Path.Path;
    const resolvers = yield* SourceResolvers;

    const [row] = yield* db
      .select({ source, variant: sourceVariant, root: libraryRoot.path, file: localFile.path })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .leftJoin(localFile, eq(localFile.sourceId, source.id))
      .leftJoin(libraryRoot, eq(libraryRoot.id, localFile.libraryRootId))
      .where(eq(source.id, sourceId))
      .limit(1)
      .pipe(Effect.orDie);
    if (row === undefined) return yield* new PlaybackUnavailable({ reason: "not_found" });

    const format = {
      container: audioContainer(row.variant.container),
      codec: row.variant.codec,
    };

    if (row.root !== null && row.file !== null) {
      return new FilePlayback({ format, path: path.join(row.root, row.file) });
    }

    const resolve = resolvers.get(row.source.provider);
    if (resolve === undefined) return yield* new PlaybackUnavailable({ reason: "not_found" });

    const credentials = yield* loadCredentials(userId, row.source.provider);
    if (Option.isNone(credentials)) {
      return yield* new PlaybackUnavailable({ reason: "account_required" });
    }

    return new ProviderPlayback({
      format,
      demuxer: row.variant.container,
      resolve: resolve(row.source.externalId, credentials.value),
    });
  });

export const preparePlayback = (sourceId: string, capabilities: PlaybackCapabilities) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const playable = yield* playableSource(sourceId, principal.userId);
    const selection = choosePlayback(playable.format, capabilities);
    if (Option.isNone(selection))
      return yield* new PlaybackUnavailable({ reason: "unsupported_format" });
    const choice = selection.value;

    const grant = new StreamGrant({
      sourceId,
      format: choice.format,
      userId: principal.userId,
      expiresAt: (yield* Clock.currentTimeMillis) + streamLifetimeMs,
    });
    const search = new URLSearchParams({
      container: grant.format.container,
      codec: grant.format.codec,
      user: grant.userId,
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
        : { decryption_keys: keys.map(([kid, key]) => `${kid}=${key}`).join(":") };

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
  expires: Schema.NumberFromString,
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
      expiresAt: request.expires,
    });
    const valid = yield* verifyGrant(grant, request.signature);
    const now = yield* Clock.currentTimeMillis;
    if (!valid || grant.expiresAt < now) return HttpServerResponse.empty({ status: 403 });

    const playable = yield* playableSource(request.sourceId, grant.userId);

    // A stream URL is stateless. Recheck the selected output against the current source.
    const selection = choosePlayback(
      playable.format,
      new PlaybackCapabilities({ formats: [grant.format] }),
    );
    if (Option.isNone(selection)) {
      return yield* new PlaybackUnavailable({ reason: "unsupported_format" });
    }
    const choice = selection.value;
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
        // Provider URLs and key material must not enter logs
        Stream.tapError(() =>
          Effect.logError("Playback stream failed").pipe(
            Effect.annotateLogs({ sourceId: request.sourceId, operation: choice.operation }),
          ),
        ),
      ),
      { contentType },
    );
  }).pipe(
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      PlaybackUnavailable: (error) =>
        Effect.succeed(HttpServerResponse.empty({ status: unavailableStatus[error.reason] })),
      ResolveError: (error) =>
        Effect.logError("Cannot resolve the source", error.reason).pipe(
          Effect.as(HttpServerResponse.empty({ status: 502 })),
        ),
    }),
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
  ),
);
