import { device, deviceDownload, source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  AudioCodec,
  AudioContainer,
  AudioFormat,
  AudioQuality,
  CurrentPrincipal,
  DeviceId,
  DownloadLease,
  DownloadPlan,
  DownloadQuality,
  DownloadUnavailable,
  PlaybackCapabilities,
} from "@dyad/domain";
import { encodeAudio } from "@dyad/media/encode";
import { remuxAudio } from "@dyad/media/node";
import type { MediaStream } from "@dyad/media/node";
import { and, eq, inArray } from "drizzle-orm";
import { Array as Arr, Clock, Data, Effect, Option, Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import {
  FilePlayback,
  ProviderPlayback,
  findPlayableSource,
  hasDevice,
  providerStream,
  signGrant,
  verifyGrant,
} from "./playback.ts";
import { choosePlayback, contentTypes, streamingCodecs } from "./playback-formats.ts";
import type { SourceFormat } from "./playback-formats.ts";
import { Providers, usableProviders } from "./providers.ts";
import { addProviderSource } from "./sources.ts";

const dayMs = 24 * 60 * 60 * 1000;
// Long enough for a queue of downloads on a slow connection
const urlLifetimeMs = 24 * 60 * 60 * 1000;

type Encoding = Omit<Parameters<typeof encodeAudio>[1], "container">;

// The first codec that the device decodes wins. The first bitrate is the target that a lossy
// source must exceed before it is encoded again.
const lossyTargets = {
  high: [
    ["aac", 256_000],
    ["mp3", 256_000],
  ],
  normal: [
    ["aac", 128_000],
    ["mp3", 128_000],
  ],
  // MP3 needs more bits than Opus for the same quality
  data_saver: [
    ["opus", 64_000],
    ["aac", 96_000],
    ["mp3", 96_000],
  ],
} satisfies Record<string, ReadonlyArray<readonly [Encoding["codec"], number]>>;

class DownloadChoice extends Data.Class<{
  readonly format: AudioFormat;
  /** `null`: the file keeps the audio of the source */
  readonly encode: Encoding | null;
  /** Without encode: the original bytes of a local file */
  readonly direct: boolean;
}> {}

// Provider sources often have no bit depth or bitrate
const chooseDownload = (
  format: SourceFormat,
  audio: AudioQuality,
  quality: typeof DownloadQuality.Type,
  capabilities: PlaybackCapabilities,
) =>
  Effect.gen(function* () {
    const playback = yield* choosePlayback(format, capabilities).pipe(Effect.option);
    const kept = Option.filter(playback, (choice) => choice.operation !== "transcode").pipe(
      Option.map(
        (choice) =>
          new DownloadChoice({
            format: choice.format,
            encode: null,
            direct: choice.operation === "direct",
          }),
      ),
    );
    const encodeAs = (codec: Encoding["codec"], bitrate: number | null, bitDepth: 16 | null) =>
      Option.fromUndefinedOr(
        capabilities.formats.find(
          (candidate) =>
            candidate.codec === codec &&
            streamingCodecs[candidate.container].some((written) => written === codec),
        ),
      ).pipe(
        Option.map(
          (target) =>
            new DownloadChoice({
              format: target,
              encode: { codec, bitrate, bitDepth },
              direct: false,
            }),
        ),
      );

    const original = quality === "original" || quality === "lossless";
    if (audio.lossless && original) {
      const sixteenBit = quality === "lossless";
      const keeps = Option.filter(
        kept,
        (choice) => !sixteenBit || (choice.format.codec === "flac" && (audio.bitDepth ?? 16) <= 16),
      );
      return Option.orElse(keeps, () => encodeAs("flac", null, sixteenBit ? 16 : null));
    }

    // A lossy source never becomes lossless. When the device cannot decode it, it gets `high`.
    const targets = lossyTargets[original ? "high" : quality];
    const limit = targets[0]?.[1] ?? 0;
    const sourceBitrate = audio.lossless ? null : audio.bitrate;
    if (!audio.lossless && (original || sourceBitrate === null || sourceBitrate <= limit)) {
      if (Option.isSome(kept)) return kept;
    }
    return Arr.findFirst(targets, ([codec, bitrate]) =>
      encodeAs(codec, Math.min(bitrate, sourceBitrate ?? bitrate), null),
    );
  });

// How the user can download the source, by the same rules as playback and the provider's policy.
// A search result enters the shared catalog here.
const downloadSource = (
  sourceId: string,
  quality: typeof DownloadQuality.Type,
  capabilities: PlaybackCapabilities,
) =>
  Effect.gen(function* () {
    const { playable, audio, searchResult } = yield* findPlayableSource(sourceId).pipe(
      Effect.catchTag("PlaybackUnavailable", (error) =>
        // Only a plan fails with `failed`, after it tried the copies
        Effect.fail(
          new DownloadUnavailable({
            reason: error.reason === "failed" ? "not_found" : error.reason,
          }),
        ),
      ),
    );
    const leaseDays =
      playable instanceof FilePlayback
        ? Option.some(null)
        : Option.fromUndefinedOr((yield* Providers).get(playable.provider)?.download).pipe(
            Option.map((policy) => policy.leaseDays),
          );
    if (Option.isNone(leaseDays)) return yield* new DownloadUnavailable({ reason: "not_allowed" });

    const choice = yield* chooseDownload(playable.format, audio, quality, capabilities);
    if (Option.isNone(choice)) {
      return yield* new DownloadUnavailable({ reason: "unsupported_format" });
    }

    if (Option.isSome(searchResult)) yield* addProviderSource(searchResult.value);
    return { playable, audio, choice: choice.value, leaseDays: leaseDays.value };
  });

class DownloadGrant extends Data.Class<{
  readonly sourceId: string;
  readonly quality: typeof DownloadQuality.Type;
  readonly format: AudioFormat;
  readonly deviceId: DeviceId;
  readonly expiresAt: number;
}> {}

const grantLines = (grant: DownloadGrant) => [
  "download",
  grant.sourceId,
  grant.quality,
  grant.format.container,
  grant.format.codec,
  grant.deviceId,
  grant.expiresAt,
];

export const prepareDownload = (
  sourceId: string,
  quality: typeof DownloadQuality.Type,
  capabilities: PlaybackCapabilities,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    const { audio, choice, leaseDays } = yield* downloadSource(sourceId, quality, capabilities);

    const now = yield* Clock.currentTimeMillis;
    const leaseExpiresAt = leaseDays === null ? null : now + leaseDays * dayMs;
    yield* db
      .insert(deviceDownload)
      .values({ deviceId: principal.deviceId, sourceId, quality, leaseExpiresAt, createdAt: now })
      .onConflictDoUpdate({
        target: [deviceDownload.deviceId, deviceDownload.sourceId],
        set: { quality, leaseExpiresAt },
      });

    const grant = new DownloadGrant({
      sourceId,
      quality,
      format: choice.format,
      deviceId: principal.deviceId,
      expiresAt: now + urlLifetimeMs,
    });
    const search = new URLSearchParams({
      quality,
      container: grant.format.container,
      codec: grant.format.codec,
      device: grant.deviceId,
      expires: String(grant.expiresAt),
      signature: yield* signGrant(grantLines(grant)),
    });
    const encode = choice.encode;
    const flac = encode?.codec === "flac";
    return new DownloadPlan({
      format: choice.format,
      bitrate: encode?.bitrate ?? null,
      path: `/download/${sourceId}?${search}`,
      leaseExpiresAt,
      audio:
        encode === null
          ? audio
          : new AudioQuality({
              codec: encode.codec,
              lossless: flac,
              // Lossy encoders can resample
              sampleRate: flac ? audio.sampleRate : null,
              bitDepth: flac ? (encode.bitDepth ?? audio.bitDepth) : null,
              bitrate: encode.bitrate,
            }),
    });
  });

/**
 * Keeps the records of `sourceIds` that the device may still keep and renews their leases. It
 * forgets the other records of the device.
 */
export const checkInDownloads = (sourceIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    const usable = yield* usableProviders;
    const now = yield* Clock.currentTimeMillis;

    const records = yield* db
      .select({ record: deviceDownload, provider: source.provider })
      .from(deviceDownload)
      .innerJoin(source, eq(source.id, deviceDownload.sourceId))
      .where(eq(deviceDownload.deviceId, principal.deviceId));
    const listed = new Set(sourceIds);
    const kept = records.flatMap(({ record, provider }) => {
      if (!listed.has(record.sourceId)) return [];
      if (provider === "local") return [{ ...record, leaseExpiresAt: null }];

      const policy = usable.get(provider)?.provider.download;
      if (policy === undefined) return [];
      const leaseExpiresAt = policy.leaseDays === null ? null : now + policy.leaseDays * dayMs;
      return [{ ...record, leaseExpiresAt }];
    });

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx.delete(deviceDownload).where(eq(deviceDownload.deviceId, principal.deviceId));
        for (const rows of Arr.chunksOf(kept, 500)) yield* tx.insert(deviceDownload).values(rows);
      }),
    );
    return kept.map(
      (record) =>
        new DownloadLease({ sourceId: record.sourceId, leaseExpiresAt: record.leaseExpiresAt }),
    );
  });

/** The devices drop the files of `provider` at their next check-in */
export const forgetDownloads = (provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .delete(deviceDownload)
      .where(
        and(
          inArray(deviceDownload.deviceId, db.select({ id: device.id }).from(device)),
          inArray(
            deviceDownload.sourceId,
            db.select({ id: source.id }).from(source).where(eq(source.provider, provider)),
          ),
        ),
      );
  });

const unavailableStatus = {
  not_found: 404,
  unsupported_format: 406,
  account_required: 403,
  not_allowed: 403,
};

const DownloadRequest = Schema.Struct({
  sourceId: Schema.String.check(Schema.isUUID()),
  quality: DownloadQuality,
  container: AudioContainer,
  codec: AudioCodec,
  device: DeviceId,
  expires: Schema.FiniteFromString,
  signature: Schema.String,
});

export const downloadRoute = HttpRouter.add(
  "GET",
  "/download/:sourceId",
  Effect.gen(function* () {
    const request = yield* HttpRouter.schemaParams(DownloadRequest);
    const grant = new DownloadGrant({
      sourceId: request.sourceId,
      quality: request.quality,
      format: new AudioFormat({ container: request.container, codec: request.codec }),
      deviceId: request.device,
      expiresAt: request.expires,
    });
    if (
      !(yield* verifyGrant(grantLines(grant), grant.expiresAt, request.signature)) ||
      !(yield* hasDevice(grant.deviceId))
    ) {
      return HttpServerResponse.empty({ status: 403 });
    }

    // The URL is stateless, so the choice repeats against the current source and policy
    const { playable, choice } = yield* downloadSource(
      grant.sourceId,
      grant.quality,
      new PlaybackCapabilities({ formats: [grant.format] }),
    );
    const contentType = contentTypes[choice.format.container];
    if (playable instanceof FilePlayback && choice.direct) {
      return yield* HttpServerResponse.file(playable.path, { contentType });
    }

    const encode = choice.encode;
    const convert = (media: string | MediaStream) =>
      encode === null
        ? remuxAudio(media, choice.format.container)
        : encodeAudio(media, { container: choice.format.container, ...encode });
    const body =
      playable instanceof ProviderPlayback
        ? yield* providerStream(playable, grant.sourceId, 0, convert)
        : convert(playable.path);

    return HttpServerResponse.stream(
      body.pipe(
        // The error text can contain provider URLs or key material, so only its name is logged
        Stream.tapError((error) =>
          Effect.logError("Download failed").pipe(
            Effect.annotateLogs({ sourceId: grant.sourceId, error: error.name }),
          ),
        ),
      ),
      { contentType },
    );
  }).pipe(
    orDieOnDatabaseError("download"),
    Effect.catchTags({
      SchemaError: () => Effect.succeed(HttpServerResponse.empty({ status: 400 })),
      DownloadUnavailable: (error) =>
        Effect.succeed(HttpServerResponse.empty({ status: unavailableStatus[error.reason] })),
      ProviderError: (error) =>
        Effect.logError("Cannot resolve the source", error.reason).pipe(
          Effect.as(HttpServerResponse.empty({ status: 502 })),
        ),
    }),
    Effect.orElseSucceed(() => HttpServerResponse.empty({ status: 500 })),
  ),
);
