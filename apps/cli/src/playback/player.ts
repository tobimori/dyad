import { ServerConnection } from "@dyad/client-runtime";
import { AudioFormat, PlaybackCapabilities } from "@dyad/domain";
import type { Audio, AudioStream } from "@opentui/core";
import { Array as Arr, Data, Deferred, Effect, Semaphore, Stream, SubscriptionRef } from "effect";
import { HttpClient } from "effect/http";

import { findSeekPoint, startPoint } from "./seek.ts";
import type { SeekPoint } from "./seek.ts";

class PlaybackError extends Data.TaggedError("PlaybackError")<{ readonly cause: unknown }> {}

// OpenTUI 0.6.6 decodes no other compressed audio
const decoders = [
  ["mp3", new AudioFormat({ container: "mp3", codec: "mp3" })],
  ["flac", new AudioFormat({ container: "flac", codec: "flac" })],
] as const;

const capabilities = new PlaybackCapabilities({
  formats: Arr.map(decoders, ([, format]) => format),
});

class Received extends Data.Class<{
  /** All bytes so far. Later chunks do not change this view. */
  readonly bytes: Uint8Array;
  readonly state: "loading" | "done" | "failed";
}> {}

// Keeps the whole response in one buffer, so that a seek can start a decoder anywhere in it
const download = <E>(
  body: Stream.Stream<Uint8Array, E>,
  received: SubscriptionRef.SubscriptionRef<Received>,
) =>
  Effect.gen(function* () {
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
  }).pipe(
    Effect.catch(() =>
      SubscriptionRef.update(received, (current) => new Received({ ...current, state: "failed" })),
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

export class Track extends Data.Class<{
  readonly position: () => number;
  /** Length of the received audio, after the download ends */
  readonly durationMs: () => number | null;
  /** Continues at `ms`, or at the last received frame before it */
  readonly seek: (ms: number) => Effect.Effect<void>;
  readonly ended: Effect.Effect<void, PlaybackError>;
}> {}

/** Closing the scope stops the stream and the request */
export const openTrack = (audio: Audio, serverUrl: string, sourceId: string) =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const plan = yield* connection.preparePlayback({ sourceId, capabilities });
    const decoder = decoders.find(
      ([, format]) =>
        format.container === plan.format.container && format.codec === plan.format.codec,
    );
    if (decoder === undefined) {
      return yield* new PlaybackError({ cause: "The server chose an undeclared format" });
    }
    const format = decoder[0];

    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(new URL(plan.path, serverUrl));
    const received = yield* SubscriptionRef.make(
      new Received({ bytes: new Uint8Array(0), state: "loading" }),
    );
    yield* Effect.forkScoped(download(response.stream, received));

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

    const play = (point: SeekPoint) =>
      Effect.gen(function* () {
        stopStream();

        const body = Stream.concat(Stream.succeed(point.prefix), readFrom(received, point.offset));
        const next = yield* Effect.tryPromise({
          try: () => audio.playStream(Stream.toReadableStream(body), { format }),
          catch: (cause) => new PlaybackError({ cause }),
        });

        stream = next;
        streamStartMs = point.ms;
        next.once("ended", () => {
          if (stream === next) Deferred.doneUnsafe(ended, Effect.void);
        });
        next.once("error", (cause) => {
          if (stream === next)
            Deferred.doneUnsafe(ended, Effect.fail(new PlaybackError({ cause })));
        });
      });

    yield* play(startPoint);

    const position = () => {
      if (stream === null) return streamStartMs;
      const stats = stream.getStats();
      if (stats.sampleRate === 0) return streamStartMs;
      return streamStartMs + (Number(stats.framesPlayed) / stats.sampleRate) * 1000;
    };

    let downloadedMs: number | null = null;
    const durationMs = () => {
      if (downloadedMs !== null) return downloadedMs;
      const current = SubscriptionRef.getUnsafe(received);
      if (current.state !== "done") return null;
      downloadedMs = findSeekPoint(current.bytes, format, Number.POSITIVE_INFINITY)?.ms ?? null;
      return downloadedMs;
    };

    const seek = (ms: number) =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(received);
        const point = findSeekPoint(current.bytes, format, ms);
        if (point === undefined) return;
        yield* play(point);
      }).pipe(
        Semaphore.withPermits(seeks, 1),
        Effect.catch((error) => Deferred.fail(ended, error)),
      );

    return new Track({ position, durationMs, seek, ended: Deferred.await(ended) });
  });
