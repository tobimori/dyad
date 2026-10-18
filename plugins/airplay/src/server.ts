import { OutputError, OutputInfo, Plugin, TimedOutput, TimedOutputs } from "@dyad/plugin";
import type { TimedMedia } from "@dyad/plugin";
import { Clock, Deferred, Effect, Equal, Fiber, Match, Queue, Schedule, Stream } from "effect";
import { HttpClient } from "effect/http";

import { type AirPlayDevice, raopAccess } from "./device.ts";
import { discover } from "./discovery.ts";
import type { AirPlayError, AirPlayNetworkError } from "./errors.ts";
import { addMillis, NtpClock, ntpClockLayer } from "./raop/ntp.ts";
import { Artwork, openRaopSender, TrackMetadata } from "./raop/sender.ts";

const outputError = (error: AirPlayError) =>
  new OutputError({
    reason: Match.valueTags(error, {
      AirPlayAuthRequired: () => "The receiver needs a password",
      AirPlayUnsupported: ({ reason }) => reason,
      AirPlayNetworkError: () => "The connection to the receiver failed",
      AirPlayRequestFailed: ({ method, status }) =>
        `The receiver answered ${method} with ${status}`,
    }),
  });

const sameInfos = (left: ReadonlyArray<OutputInfo>, right: ReadonlyArray<OutputInfo>) =>
  left.length === right.length && left.every((info, index) => Equal.equals(info, right[index]));

const artworkTypes = ["image/jpeg", "image/png"] as const;

/**
 * The receivers of `devices` that accept plain RAOP, as timed outputs. All of them follow one NTP
 * clock, so that they play in sync.
 */
export const airplayOutputs = Effect.fn("AirPlay.outputs")(function* (
  devices: Stream.Stream<AirPlayDevice, AirPlayNetworkError>,
) {
  const clock = yield* Effect.provide(NtpClock, ntpClockLayer);
  const http = yield* HttpClient.HttpClient;

  // One offset maps server time to the NTP clock, which runs at the rate of the monotonic clock
  const ntpOrigin = yield* clock.now;
  const serverOrigin = Number((yield* Clock.monotonicTimeNanos) / 1000n);
  const ntpTime = (serverUs: number) => addMillis(ntpOrigin, (serverUs - serverOrigin) / 1000);

  const artwork = (url: string) =>
    http.get(url).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          const mimeType = artworkTypes.find((type) =>
            response.headers["content-type"]?.startsWith(type),
          );
          if (response.status !== 200 || mimeType === undefined) return undefined;
          return new Artwork({ bytes: new Uint8Array(yield* response.arrayBuffer), mimeType });
        }),
      ),
      Effect.timeout("5 seconds"),
      Effect.orElseSucceed(() => undefined),
    );

  const openOutput = (device: AirPlayDevice) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const sender = yield* openRaopSender(device).pipe(
        Effect.provideService(NtpClock, clock),
        Effect.mapError(outputError),
      );
      const failed = yield* Deferred.make<never, OutputError>();

      // One `play` per epoch: its last packet is padded with silence, so contiguous blocks must
      // stay in one play
      let playing:
        | { readonly queue: Queue.Queue<Float32Array>; readonly fiber: Fiber.Fiber<unknown> }
        | undefined;

      const write = (playAtUs: number, pcm: Float32Array) =>
        Effect.gen(function* () {
          if (yield* Deferred.isDone(failed)) return yield* Deferred.await(failed);
          if (playing === undefined) {
            const queue = yield* Queue.unbounded<Float32Array>();
            const fiber = yield* sender.play(Stream.fromQueue(queue), ntpTime(playAtUs)).pipe(
              Effect.catch((error) => Deferred.fail(failed, outputError(error))),
              Effect.forkIn(scope),
            );
            playing = { queue, fiber };
          }
          yield* Queue.offer(playing.queue, pcm);
        });

      const flush = Effect.gen(function* () {
        if (playing !== undefined) {
          yield* Fiber.interrupt(playing.fiber);
          playing = undefined;
        }
        yield* sender.flush.pipe(Effect.mapError(outputError));
      });

      const setMedia = (media: TimedMedia) =>
        Effect.gen(function* () {
          const art =
            media.artworkUrl === null || !device.metadata.includes(1)
              ? undefined
              : yield* artwork(media.artworkUrl);
          yield* sender.setMetadata(
            new TrackMetadata({
              title: media.title ?? "",
              artist: media.artist ?? undefined,
              album: media.album ?? undefined,
              artwork: art,
              startAt: ntpTime(media.startAtUs),
              durationMs: media.durationMs ?? undefined,
            }),
          );
        }).pipe(Effect.mapError(outputError));

      return new TimedOutput({
        leadMs: sender.leadMs,
        write,
        flush,
        setVolume: (volume) => sender.setVolume(volume).pipe(Effect.mapError(outputError)),
        setMedia,
        closed: Effect.raceFirst(
          sender.closed.pipe(Effect.mapError(outputError)),
          Deferred.await(failed),
        ),
      });
    });

  const found = new Map<string, AirPlayDevice>();
  const discoverOutputs = devices.pipe(
    Stream.tap((device) => Effect.sync(() => found.set(device.id, device))),
    Stream.map(() =>
      [...found.values()].flatMap((device) =>
        raopAccess(device) === "raop" ? [new OutputInfo({ id: device.id, name: device.name })] : [],
      ),
    ),
    Stream.changesWith(sameInfos),
    Stream.tapError((error) => Effect.logWarning("AirPlay discovery failed", String(error))),
    Stream.retry(Schedule.spaced("30 seconds")),
    // The schedule has no end
    Stream.orDie,
  );

  return new TimedOutputs({
    discover: discoverOutputs,
    open: (id) => {
      const device = found.get(id);
      return device === undefined
        ? Effect.fail(new OutputError({ reason: "The receiver was not discovered" }))
        : openOutput(device);
    },
  });
});

/** AirPlay receivers on the local network as timed outputs */
export const airplayPlugin = new Plugin({
  id: "dyad.airplay",
  setup: (context) =>
    Effect.gen(function* () {
      yield* context.outputs.addTimed("airplay", yield* airplayOutputs(discover));
    }),
});
