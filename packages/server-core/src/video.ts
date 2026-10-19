import { source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import { CurrentPrincipal, DeviceId, PlaybackUnavailable, VideoPlan } from "@dyad/domain";
import { eq } from "drizzle-orm";
import { Clock, Data, Effect, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { hasDevice, signGrant, unavailableStatus, verifyGrant } from "./playback.ts";
import { cachedProviderSource } from "./provider-cache.ts";
import { usableProviders } from "./providers.ts";

// The same lifetime as audio stream URLs
const videoLifetimeMs = 6 * 60 * 60 * 1000;

class VideoGrant extends Data.Class<{
  readonly sourceId: string;
  readonly deviceId: DeviceId;
  readonly expiresAt: number;
}> {}

const grantLines = (grant: VideoGrant) => [
  "video",
  grant.sourceId,
  grant.deviceId,
  grant.expiresAt,
];

// A search result is not in the catalog yet, so it comes from the provider cache
const findVideo = Effect.fnUntraced(function* (sourceId: string) {
  const db = yield* Database;
  const [row] = yield* db
    .select({ provider: source.provider, externalId: source.externalId })
    .from(source)
    .where(eq(source.id, sourceId))
    .limit(1);
  const item =
    row ??
    Option.getOrUndefined(
      Option.map(yield* cachedProviderSource(sourceId), (cached) => ({
        provider: cached.provider,
        externalId: cached.source.externalId,
      })),
    );
  if (item === undefined) return yield* new PlaybackUnavailable({ reason: "not_found" });

  const usable = (yield* usableProviders).get(item.provider);
  if (usable === undefined) {
    return yield* new PlaybackUnavailable({ reason: "account_required" });
  }
  const video = usable.provider.video;
  if (video === undefined) return yield* new PlaybackUnavailable({ reason: "not_found" });
  return (maxHeight: number) => video(item.externalId, usable.credentials, maxHeight);
});

/** A signed video URL for the device. It stops working when the device is removed. */
export const prepareVideo = Effect.fn("prepareVideo")(function* (
  sourceId: string,
  maxHeight: number,
) {
  const principal = yield* CurrentPrincipal;
  yield* findVideo(sourceId);

  const grant = new VideoGrant({
    sourceId,
    deviceId: principal.deviceId,
    expiresAt: (yield* Clock.currentTimeMillis) + videoLifetimeMs,
  });
  const search = new URLSearchParams({
    device: grant.deviceId,
    expires: String(grant.expiresAt),
    height: String(maxHeight),
    signature: yield* signGrant(grantLines(grant)),
  });
  return new VideoPlan({ path: `/video/${sourceId}?${search}` });
});

const VideoRequest = Schema.Struct({
  sourceId: Schema.String.check(Schema.isUUID()),
  device: DeviceId,
  expires: Schema.FiniteFromString,
  signature: Schema.String,
  // Not in the signature: any height and start of a granted video is allowed
  height: Schema.FiniteFromString.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: 4320 }),
  ),
  start: Schema.optionalKey(
    Schema.FiniteFromString.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  ),
});

/** Passes the provider's bytes through, so that the provider sees only the server */
export const videoRoute = HttpRouter.add(
  "GET",
  "/video/:sourceId",
  Effect.gen(function* () {
    const request = yield* HttpRouter.schemaParams(VideoRequest);
    const grant = new VideoGrant({
      sourceId: request.sourceId,
      deviceId: request.device,
      expiresAt: request.expires,
    });
    if (
      !(yield* verifyGrant(grantLines(grant), grant.expiresAt, request.signature)) ||
      !(yield* hasDevice(grant.deviceId))
    ) {
      return HttpServerResponse.empty({ status: 403 });
    }

    const resolve = yield* findVideo(request.sourceId);
    // The provider resolves before the response starts, so that a failure gives an error status
    const video = yield* resolve(request.height);
    const startMs = request.start ?? 0;
    const body = startMs > 0 ? video.bytesFrom(startMs) : video.bytes;

    return HttpServerResponse.stream(
      body.pipe(
        // The error text can contain provider URLs, so only its name is logged
        Stream.tapError((error) =>
          Effect.logError("Video stream failed").pipe(
            Effect.annotateLogs({ sourceId: request.sourceId, error: error.name }),
          ),
        ),
      ),
      { contentType: "video/webm" },
    );
  }).pipe(
    orDieOnDatabaseError("video"),
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      PlaybackUnavailable: (error) =>
        Effect.succeed(HttpServerResponse.empty({ status: unavailableStatus[error.reason] })),
      ProviderError: (error) =>
        Effect.logError("Cannot resolve the video", error.reason).pipe(
          Effect.as(HttpServerResponse.empty({ status: 502 })),
        ),
    }),
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
  ),
);
