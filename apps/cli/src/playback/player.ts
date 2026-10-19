import { findSeekPoint, readSourceInfo, SeekPoint } from "@dyad/audio";
import { ServerConnection, copyLabel, qualityLabel } from "@dyad/client-runtime";
import { AudioFormat, PlaybackCapabilities } from "@dyad/domain";
import type { AudioQuality } from "@dyad/domain";
import type { Audio, AudioStream } from "@opentui/core";
import {
  Array as Arr,
  Data,
  Deferred,
  Effect,
  Exit,
  FileSystem,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient } from "effect/http";

import { ResponseTap } from "../visualizer/audio-feed.ts";

class PlaybackError extends Data.TaggedError("PlaybackError")<{ readonly cause: unknown }> {}

// OpenTUI 0.6.6 decodes no other compressed audio
const decoders = [
  ["mp3", new AudioFormat({ container: "mp3", codec: "mp3" })],
  ["flac", new AudioFormat({ container: "flac", codec: "flac" })],
] as const;

export const capabilities = new PlaybackCapabilities({
  formats: Arr.map(decoders, ([, format]) => format),
});

class Received extends Data.Class<{
  /** All bytes so far. Later chunks do not change this view. */
  readonly bytes: Uint8Array;
  readonly state: "loading" | "done" | "failed";
}> {}

// Keeps the whole response in one buffer, so that a seek can start a decoder anywhere in it
const download = Effect.fn(
  function* <E>(
    body: Stream.Stream<Uint8Array, E>,
    received: SubscriptionRef.SubscriptionRef<Received>,
  ) {
    let buffer = new Uint8Array(1024 * 1024);
    let length = 0;

    yield* Stream.runForEach(body, (chunk) => {
      if (length + chunk.length > buffer.length) {
        const larger = new Uint8Array(Math.max(buffer.length * 2, length + chunk.length));
        larger.set(buffer.subarray(0, length));
        buffer = larger;
      }
      buffer.set(chunk, length);
      length += chunk.length;
      return SubscriptionRef.set(
        received,
        new Received({ bytes: buffer.subarray(0, length), state: "loading" }),
      );
    });

    yield* SubscriptionRef.set(
      received,
      new Received({ bytes: buffer.subarray(0, length), state: "done" }),
    );
  },
  (effect, body, received) =>
    effect.pipe(
      Effect.catch(() =>
        SubscriptionRef.update(
          received,
          (current) => new Received({ ...current, state: "failed" }),
        ),
      ),
    ),
);

// The received bytes from `offset`, and then each new chunk until the download ends
const readFrom = (received: SubscriptionRef.SubscriptionRef<Received>, offset: number) =>
  SubscriptionRef.changes(received).pipe(
    Stream.takeUntil((current) => current.state !== "loading"),
    Stream.mapEffect((current) =>
      current.state === "failed"
        ? Effect.fail(new PlaybackError({ cause: "The download failed" }))
        : Effect.succeed(current.bytes),
    ),
    Stream.mapAccum(
      () => offset,
      (position, bytes) => [Math.max(position, bytes.length), [bytes.subarray(position)]] as const,
    ),
    Stream.filter((chunk) => chunk.length > 0),
  );

/** One response of the stream. A response with `start` begins `startMs` into the source. */
class Download extends Data.Class<{
  readonly startMs: number;
  readonly received: SubscriptionRef.SubscriptionRef<Received>;
  /** Closing it stops the request */
  readonly scope: Scope.Closeable;
  readonly tap: ResponseTap;
}> {}

type Format = (typeof decoders)[number][0];

const startPoint = new SeekPoint({ prefix: new Uint8Array(0), offset: 0, frame: 0 });

// The grant in `path` stays valid for hours, so a new start needs no new `preparePlayback`
const startDownload = Effect.fn(function* (
  serverUrl: string,
  path: string,
  format: Format,
  startMs: number,
) {
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const url = new URL(path, serverUrl);
  if (startMs > 0) url.searchParams.set("start", String(Math.floor(startMs)));

  const scope = yield* Scope.fork(yield* Effect.scope);
  const response = yield* client.get(url).pipe(
    Scope.provide(scope),
    Effect.mapError((cause) => new PlaybackError({ cause })),
  );
  const received = yield* SubscriptionRef.make(
    new Received({ bytes: new Uint8Array(0), state: "loading" }),
  );
  yield* Effect.forkIn(download(response.stream, received), scope);
  const tap = new ResponseTap({
    codec: format,
    startMs,
    bytes: () => SubscriptionRef.getUnsafe(received).bytes,
    complete: () => SubscriptionRef.getUnsafe(received).state !== "loading",
  });
  return new Download({ startMs, received, scope, tap });
});

/** The whole response of a source. The engine keeps it for the next entries and for offline play. */
export class Fetched extends Data.Class<{
  /** `null` for a downloaded file, which has all audio */
  readonly path: string | null;
  readonly format: Format;
  readonly quality: string;
  /** Where the audio comes from when the server plays another source, see `copyLabel` */
  readonly copy: string | null;
  readonly download: Download;
}> {}

export const downloadState = (fetched: Fetched) =>
  SubscriptionRef.getUnsafe(fetched.download.received).state;

export const downloadedBytes = (fetched: Fetched) =>
  SubscriptionRef.getUnsafe(fetched.download.received).bytes.length;

const decoderOf = (format: AudioFormat) =>
  decoders.find(
    ([, candidate]) => candidate.container === format.container && candidate.codec === format.codec,
  )?.[0];

/** Closing the scope stops the download */
export const fetchSource = Effect.fn("fetchSource")(function* (
  serverUrl: string,
  entry: { readonly source: { readonly id: string }; readonly pinned: boolean },
) {
  const connection = yield* ServerConnection;
  const plan = yield* connection.preparePlayback({
    sourceId: entry.source.id,
    pinned: entry.pinned,
    capabilities,
  });
  const decoder = decoderOf(plan.format);
  if (decoder === undefined) {
    return yield* new PlaybackError({ cause: "The server chose an undeclared format" });
  }

  const download = yield* startDownload(serverUrl, plan.path, decoder, 0);
  const copy = copyLabel(plan);
  const quality = qualityLabel(plan.source, plan.format);
  return new Fetched({
    path: plan.path,
    format: decoder,
    quality: copy === null ? quality : `${copy} · ${quality}`,
    copy,
    download,
  });
});

/** Reads a downloaded file into memory, like a complete response */
export const fetchFile = Effect.fn("fetchFile")(function* (
  path: string,
  format: AudioFormat,
  audio: AudioQuality | null,
) {
  const fs = yield* FileSystem.FileSystem;
  const decoder = decoderOf(format);
  if (decoder === undefined) {
    return yield* new PlaybackError({ cause: "The file has an undeclared format" });
  }

  const bytes = yield* fs
    .readFile(path)
    .pipe(Effect.mapError((cause) => new PlaybackError({ cause })));
  const received = yield* SubscriptionRef.make(new Received({ bytes, state: "done" }));
  const tap = new ResponseTap({
    codec: decoder,
    startMs: 0,
    bytes: () => bytes,
    complete: () => true,
  });
  const scope = yield* Scope.fork(yield* Effect.scope);
  return new Fetched({
    path: null,
    format: decoder,
    quality: qualityLabel(audio, format),
    copy: null,
    download: new Download({ startMs: 0, received, scope, tap }),
  });
});

export class Track extends Data.Class<{
  readonly position: () => number;
  /** Length of the received audio, after the download ends */
  readonly durationMs: () => number | null;
  /** `true` when the received audio contains `ms` */
  readonly covers: (ms: number) => boolean;
  /**
   * Continues at `ms`, or at the last received frame before it. Outside the received audio, it
   * requests the stream again from `ms`.
   */
  readonly seek: (ms: number) => Effect.Effect<void>;
  readonly ended: Effect.Effect<void, PlaybackError>;
  /** The response that plays now, for the visualizer */
  readonly tap: () => ResponseTap;
  readonly quality: string;
}> {}

/** Starts at `startMs`. Closing the scope stops the stream and its own requests, not `fetched`. */
export const openTrack = Effect.fn("openTrack")(function* (
  audio: Audio,
  serverUrl: string,
  fetched: Fetched,
  startMs: number,
) {
  const format = fetched.format;
  const base = fetched.download;
  let current = base;
  // A seek outside the received audio requests the stream again under the scope of the track
  const services = yield* Effect.context<HttpClient.HttpClient | Scope.Scope>();

  const ended = yield* Deferred.make<void, PlaybackError>();
  const seeks = yield* Semaphore.make(1);

  // A seek replaces the stream; events of a replaced stream are ignored
  let stream: AudioStream | null = null;
  let streamStartMs = 0;

  const stopStream = () => {
    const previous = stream;
    stream = null;
    previous?.dispose();
  };
  yield* Effect.addFinalizer(() => Effect.sync(stopStream));

  const play = Effect.fn(function* (from: Download, point: SeekPoint, pointMs: number) {
    stopStream();

    const body = Stream.concat(Stream.succeed(point.prefix), readFrom(from.received, point.offset));
    const next = yield* Effect.tryPromise({
      try: () => audio.playStream(Stream.toReadableStream(body), { format }),
      catch: (cause) => new PlaybackError({ cause }),
    });

    stream = next;
    streamStartMs = from.startMs + pointMs;
    next.once("ended", () => {
      if (stream === next) Deferred.doneUnsafe(ended, Effect.void);
    });
    next.once("error", (cause) => {
      if (stream === next) Deferred.doneUnsafe(ended, Effect.fail(new PlaybackError({ cause })));
    });
  });

  const position = () => {
    if (stream === null) return streamStartMs;
    const stats = stream.getStats();
    if (stats.sampleRate === 0) return streamStartMs;
    return streamStartMs + (Number(stats.framesPlayed) / stats.sampleRate) * 1000;
  };

  // OpenTUI 0.6.6 cannot seek in a stream, so a seek starts a new decoder at this point.
  // `ms` is relative to the start of the download.
  const seekPointIn = (bytes: Uint8Array, ms: number) => {
    const info = readSourceInfo(bytes, format);
    if (info === undefined) return undefined;
    const point = findSeekPoint(bytes, info, (ms / 1000) * info.sampleRate);
    if (point === undefined) return undefined;
    // The MP3 priming before source frame 0 shows as 0, as when the file plays from its start
    return { point, ms: Math.max(0, (point.frame / info.sampleRate) * 1000) };
  };

  // The last received seek point, relative to the start of the download
  const receivedMs = (bytes: Uint8Array) =>
    seekPointIn(bytes, Number.POSITIVE_INFINITY)?.ms ?? null;

  let downloadedMs: number | null = null;
  const durationMs = () => {
    if (downloadedMs !== null) return downloadedMs;
    const done = [base, current].find(
      (from) => SubscriptionRef.getUnsafe(from.received).state === "done",
    );
    if (done === undefined) return null;

    const lastMs = receivedMs(SubscriptionRef.getUnsafe(done.received).bytes);
    downloadedMs = lastMs === null ? null : done.startMs + lastMs;
    return downloadedMs;
  };

  // Where `from` has the audio of `ms`. Its start always plays, also before its first bytes.
  const pointIn = (from: Download, ms: number) => {
    const offsetMs = ms - from.startMs;
    if (offsetMs === 0) return { point: startPoint, ms: 0 };

    const received = SubscriptionRef.getUnsafe(from.received);
    const lastMs = receivedMs(received.bytes);
    const inside =
      offsetMs > 0 && (received.state === "done" || (lastMs !== null && offsetMs <= lastMs));
    return inside ? seekPointIn(received.bytes, offsetMs) : undefined;
  };

  // A response of this track that no longer plays stops
  const replace = (next: Download) => {
    const previous = current;
    current = next;
    return previous === base || previous === next
      ? Effect.void
      : Scope.close(previous.scope, Exit.void);
  };

  const moveTo = Effect.fn(function* (ms: number) {
    for (const from of [current, base]) {
      const start = pointIn(from, ms);
      if (start === undefined) continue;
      yield* play(from, start.point, start.ms);
      return yield* replace(from);
    }

    // A downloaded file has all audio, so the position is after its end
    if (fetched.path === null) {
      stopStream();
      yield* Deferred.succeed(ended, undefined);
      return;
    }
    // The old audio plays on until the new response starts
    const next = yield* startDownload(serverUrl, fetched.path, format, ms);
    yield* play(next, startPoint, 0);
    yield* replace(next);
  });

  yield* moveTo(startMs);

  return new Track({
    position,
    durationMs,
    covers: (ms) => pointIn(current, ms) !== undefined || pointIn(base, ms) !== undefined,
    seek: (ms) =>
      moveTo(ms).pipe(
        Semaphore.withPermits(seeks, 1),
        Effect.catch((error) => Deferred.fail(ended, error)),
        Effect.asVoid,
        Effect.provideContext(services),
      ),
    ended: Deferred.await(ended),
    tap: () => current.tap,
    quality: fetched.quality,
  });
});
