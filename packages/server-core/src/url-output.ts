import { orDieOnDatabaseError } from "@dyad/db/node";
import { PlaybackCapabilities, positionAt } from "@dyad/domain";
import type { EntryId, OutputId, Playback, QueueEntry, UserId } from "@dyad/domain";
import { OutputError, UrlMedia } from "@dyad/plugin";
import type { UrlStatus } from "@dyad/plugin";
import { Clock, Data, Effect, Fiber, Option, Schedule, Stream, SubscriptionRef } from "effect";

import { Outputs, StreamPort } from "./outputs.ts";
import { contentTypes } from "./playback-formats.ts";
import { streamPlan } from "./playback.ts";

// Until a device follows a command, its status can still show the state from before
const settleMs = 5000;
// A stop this close to the end of the entry is the end
const endToleranceMs = 3000;
// A loaded stream that does not play in this time failed, for example with an HTTP error
const startTimeoutMs = 10_000;
// A paused device continues with `play` only near the position of the session
const resumeToleranceMs = 1500;

/** What the session wants the output to play */
export class UrlDesired extends Data.Class<{
  readonly playback: Playback;
  readonly entry: QueueEntry | undefined;
}> {}

export class UrlReport extends Data.Class<{
  readonly revision: number;
  readonly entryId: EntryId;
  /** `stalled`: the device did not start this entry nor the entry before it */
  readonly state: "playing" | "paused" | "buffering" | "ended" | "failed" | "stalled";
  readonly positionMs: number;
}> {}

class Loaded extends Data.Class<{
  readonly entryId: EntryId;
  readonly url: string;
  // The stream starts at this position of the entry
  readonly startMs: number;
  readonly durationMs: number | null;
  readonly loadedAt: number;
}> {}

class Expected extends Data.Class<{
  readonly state: UrlStatus["state"];
  readonly until: number;
}> {}

class Played extends Data.Class<{
  readonly positionMs: number;
  readonly at: number;
}> {}

/**
 * Makes a URL output follow the session: it loads, plays, pauses and stops the device, and turns
 * the status of the device into reports. When the output fails, it opens it again.
 */
export const driveUrlOutput = (options: {
  readonly userId: UserId;
  readonly outputId: OutputId;
  readonly desired: UrlDesired;
  readonly report: (report: UrlReport) => Effect.Effect<void>;
  /** Another session or another controller took the output */
  readonly taken: Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const outputs = yield* Outputs;
    const port = yield* StreamPort;
    const scope = yield* Effect.scope;
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof streamPlan>>>();
    const desired = yield* SubscriptionRef.make(options.desired);
    const closing = { stop: false };

    const run = Effect.gen(function* () {
      const output = yield* outputs.open(options.outputId, {
        userId: options.userId,
        taken: options.taken,
      });
      yield* Effect.addFinalizer(() =>
        closing.stop ? output.stop.pipe(Effect.timeout("3 seconds"), Effect.ignore) : Effect.void,
      );
      const streamOrigin = `http://${output.localAddress}:${port}`;

      // Changed only in this fiber
      const local = {
        // Reports carry the revision of the last desired state that the driver applied
        revision: -1,
        loaded: Option.none<Loaded>(),
        status: Option.none<UrlStatus>(),
        expected: Option.none<Expected>(),
        played: Option.none<Played>(),
        // Start timeouts in a row
        stalls: 0,
      };

      const report = (state: UrlReport["state"], entryId: EntryId, positionMs: number) =>
        options.report(new UrlReport({ revision: local.revision, entryId, state, positionMs }));

      const command = (state: UrlStatus["state"], effect: Effect.Effect<void, OutputError>) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          local.expected = Option.some(new Expected({ state, until: now + settleMs }));
          yield* effect;
        });

      const load = (entry: QueueEntry, positionMs: number) =>
        Effect.gen(function* () {
          const startMs = Math.max(0, Math.round(positionMs));
          const plan = yield* streamPlan(
            entry.source.id,
            options.userId,
            options.outputId,
            new PlaybackCapabilities({ formats: output.formats }),
          ).pipe(
            Effect.provideContext(services),
            orDieOnDatabaseError("streamPlan"),
            Effect.option,
          );
          if (Option.isNone(plan)) return yield* report("failed", entry.id, startMs);

          const url = `${streamOrigin}${plan.value.path}&start=${startMs}`;
          const durationMs = entry.source.durationMs;
          local.loaded = Option.some(
            new Loaded({
              entryId: entry.id,
              url,
              startMs,
              durationMs,
              loadedAt: yield* Clock.currentTimeMillis,
            }),
          );
          local.played = Option.none();
          yield* command(
            "playing",
            output.load(
              new UrlMedia({
                url,
                contentType: contentTypes[plan.value.format.container],
                title: entry.source.title,
                artist: entry.source.artist,
                album: entry.source.album,
                artworkUrl: entry.source.artworkUrl,
                durationMs: durationMs === null ? null : Math.max(0, durationMs - startMs),
              }),
            ),
          );
        });

      // A desired state with the same revision and entry only moves the anchor
      const apply = Effect.gen(function* () {
        const { playback, entry } = yield* SubscriptionRef.get(desired);
        const loaded = Option.getOrUndefined(local.loaded);
        const status = Option.getOrUndefined(local.status);
        if (playback.revision === local.revision && entry?.id === loaded?.entryId) return;
        local.revision = playback.revision;

        if (playback.state === "stopped" || entry === undefined) {
          if (loaded === undefined) return;
          local.loaded = Option.none();
          return yield* command("stopped", output.stop);
        }

        if (playback.state === "paused") {
          const plays = status?.state === "playing" || status?.state === "buffering";
          if (loaded !== undefined && plays) yield* command("paused", output.pause);
          return;
        }

        const positionMs = positionAt(playback, yield* Clock.currentTimeMillis);
        // For example after the output was lost until the end of the entry
        const durationMs = entry.source.durationMs;
        if (durationMs !== null && positionMs >= durationMs) {
          return yield* report("ended", entry.id, positionMs);
        }
        const resumes =
          loaded?.entryId === entry.id &&
          status?.state === "paused" &&
          status.url === loaded.url &&
          Math.abs(loaded.startMs + status.positionMs - positionMs) < resumeToleranceMs;
        yield* resumes ? command("playing", output.play) : load(entry, positionMs);
      });

      const observe = (status: UrlStatus) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          local.status = Option.some(status);
          const loaded = Option.getOrUndefined(local.loaded);
          if (loaded === undefined) return;

          if (Option.isSome(local.expected)) {
            const expected = local.expected.value;
            const follows = status.state === expected.state && status.url === loaded.url;
            if (!follows && now < expected.until) return;
            local.expected = Option.none();
          }

          if (status.url !== loaded.url) {
            // Another controller plays its own media, for example the Sonos app
            const foreign =
              status.state === "playing" &&
              status.url !== null &&
              !status.url.startsWith(`${streamOrigin}/stream/`);
            if (foreign) yield* options.taken;
            return;
          }

          const positionMs = loaded.startMs + status.positionMs;
          if (status.state === "playing") {
            local.played = Option.some(new Played({ positionMs, at: now }));
            local.stalls = 0;
            return yield* report("playing", loaded.entryId, positionMs);
          }
          if (status.state !== "stopped")
            return yield* report(status.state, loaded.entryId, positionMs);

          if (Option.isNone(local.played)) {
            if (now - loaded.loadedAt < startTimeoutMs) return;
            local.loaded = Option.none();
            local.stalls += 1;
            const state = local.stalls > 1 ? "stalled" : "failed";
            return yield* report(state, loaded.entryId, loaded.startMs);
          }

          // A device resets its position when it stops, so the end is measured from the last report
          const played = local.played.value;
          const reached = played.positionMs + now - played.at;
          const ended = loaded.durationMs === null || reached >= loaded.durationMs - endToleranceMs;
          local.loaded = Option.none();
          yield* report(
            ended ? "ended" : "paused",
            loaded.entryId,
            ended ? reached : played.positionMs,
          );
        });

      // A stopped device sends no more status, so the start timeout needs a clock
      const recheck = Effect.suspend(() => {
        const status = Option.getOrUndefined(local.status);
        return status?.state === "stopped" ? observe(status) : Effect.void;
      });

      yield* Stream.mergeAll(
        [
          SubscriptionRef.changes(desired).pipe(Stream.as(apply)),
          output.status.pipe(Stream.map(observe)),
          Stream.tick("1 second").pipe(Stream.as(recheck)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.runForEach((effect) => effect));
      return yield* new OutputError({ reason: "The status ended" });
    });

    const fiber = yield* run.pipe(
      Effect.scoped,
      Effect.tapError((error) =>
        Effect.logWarning("URL output failed", error.reason).pipe(
          Effect.annotateLogs("outputId", options.outputId),
        ),
      ),
      Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])),
      Effect.forkIn(scope),
    );

    return {
      outputId: options.outputId,
      desire: (next: UrlDesired) => SubscriptionRef.set(desired, next),
      /** With `stop`, the device stops first. Without, another controller uses it now. */
      close: (stop: boolean) =>
        Effect.sync(() => {
          closing.stop = stop;
        }).pipe(Effect.andThen(Fiber.interrupt(fiber)), Effect.forkIn(scope), Effect.asVoid),
    };
  });

export type UrlDriver = Effect.Success<ReturnType<typeof driveUrlOutput>>;
