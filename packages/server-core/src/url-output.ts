import { orDieOnDatabaseError } from "@dyad/db/node";
import { PlaybackCapabilities, positionAt } from "@dyad/domain";
import { Playback } from "@dyad/domain";
import type { EntryId, OutputId, QueueEntry } from "@dyad/domain";
import { OutputError, UrlMedia } from "@dyad/plugin";
import type { UrlOutput, UrlStatus } from "@dyad/plugin";
import {
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Option,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import { openLiveStream } from "./live-output.ts";
import { Outputs, StreamPort } from "./outputs.ts";
import { contentTypes } from "./playback-formats.ts";
import { streamPlan } from "./playback.ts";
import { TimedDesired, driveTimedOutputs } from "./timed-output.ts";
import type { TimedDriver } from "./timed-output.ts";

// Until a device follows a command, its status can still show the state from before
const settleMs = 5000;
// A stop this close to the end of the entry is the end
const endToleranceMs = 3000;
// A loaded stream that does not play in this time failed, for example with an HTTP error
const startTimeoutMs = 10_000;
// A paused device continues with `play` only near the position of the session
const resumeToleranceMs = 1500;

/** What the session wants the output to play. `playback.group` are the members of its group. */
export class UrlDesired extends Data.Class<{
  readonly playback: Playback;
  readonly entry: QueueEntry | undefined;
  /** The entry that starts when `entry` ends */
  readonly next: QueueEntry | undefined;
  /** `entry`, then the entries that follow it in play order, for a live stream */
  readonly entries: ReadonlyArray<QueueEntry>;
}> {}

export class OutputReport extends Data.Class<{
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

// The renderer plays crossfades and DJ transitions, so the device gets them in a live stream
const rendersTransitions = (playback: Playback) =>
  playback.crossfadeSeconds > 0 || playback.djStyle !== null;

const playsLive = (output: UrlOutput) =>
  output.live === true && output.formats.some((format) => format.codec === "flac");

class Live extends Data.Class<{
  readonly driver: TimedDriver;
  readonly scope: Scope.Closeable;
}> {}

/**
 * Makes a URL output follow the session: it loads, plays, pauses and stops the device, and turns
 * the status of the device into reports. The members of `playback.group` join the group of the
 * device. With crossfade or DJ mode, a device that plays live streams gets one from the renderer.
 * When the output fails, it opens it again.
 */
export const driveUrlOutput = Effect.fn("driveUrlOutput")(function* (options: {
  readonly outputId: OutputId;
  readonly desired: UrlDesired;
  readonly report: (report: OutputReport) => Effect.Effect<void>;
  /** Another session or another controller took the output */
  readonly taken: Effect.Effect<void>;
  /** Another session or another controller took a member of the group */
  readonly memberTaken: (outputId: OutputId) => Effect.Effect<void>;
  /** The device opens after this */
  readonly after: Effect.Effect<void>;
}) {
  const outputs = yield* Outputs;
  const port = yield* StreamPort;
  const scope = yield* Effect.scope;
  // Without `Scope`, so that each live stream and renderer closes with its own scope
  const services = Context.omit(Scope.Scope)(
    yield* Effect.context<
      Effect.Services<
        ReturnType<typeof streamPlan | typeof driveTimedOutputs | typeof openLiveStream>
      >
    >(),
  );
  const desired = yield* SubscriptionRef.make(options.desired);
  const closing = { stop: false };
  // Set while the renderer plays the session on the device
  const rendering = { on: false };

  const run = Effect.gen(function* () {
    yield* options.after;
    const runScope = yield* Effect.scope;
    const output = yield* outputs.open(options.outputId, {
      taken: options.taken,
    });
    yield* Effect.addFinalizer(() =>
      closing.stop ? output.stop.pipe(Effect.timeout("3 seconds"), Effect.ignore) : Effect.void,
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => (rendering.on = false)));
    const streamOrigin = `http://${output.localAddress}:${port}`;
    const live = playsLive(output);
    const joined = new Map<OutputId, Scope.Closeable>();

    // Changed only in this fiber
    const local = {
      // Reports carry the revision of the last desired state that the driver applied
      revision: -1,
      loaded: Option.none<Loaded>(),
      // The entry that the device starts by itself after `loaded`
      next: Option.none<Loaded>(),
      // The next entry before the last queue edit. The device can start it before the edit.
      replaced: Option.none<Loaded>(),
      status: Option.none<UrlStatus>(),
      expected: Option.none<Expected>(),
      played: Option.none<Played>(),
      // Start timeouts in a row
      stalls: 0,
      live: Option.none<Live>(),
    };

    const report = (state: OutputReport["state"], entryId: EntryId, positionMs: number) =>
      options.report(new OutputReport({ revision: local.revision, entryId, state, positionMs }));

    const command = Effect.fn("command")(function* (
      state: UrlStatus["state"],
      effect: Effect.Effect<void, OutputError>,
    ) {
      const now = yield* Clock.currentTimeMillis;
      local.expected = Option.some(new Expected({ state, until: now + settleMs }));
      yield* effect;
    });

    // The stream of `entry` from `startMs`, or none when the user cannot play it
    const prepare = Effect.fn("prepare")(function* (entry: QueueEntry, startMs: number) {
      const plan = yield* streamPlan(
        entry.source.id,
        options.outputId,
        new PlaybackCapabilities({ formats: output.formats }),
      ).pipe(Effect.provideContext(services), orDieOnDatabaseError("streamPlan"), Effect.option);
      const loadedAt = yield* Clock.currentTimeMillis;
      return Option.map(plan, ({ path, format }) => {
        const url = `${streamOrigin}${path}&start=${startMs}`;
        const durationMs = entry.source.durationMs;
        return {
          loaded: new Loaded({ entryId: entry.id, url, startMs, durationMs, loadedAt }),
          media: new UrlMedia({
            url,
            contentType: contentTypes[format.container],
            title: entry.source.title,
            artist: entry.source.artist,
            album: entry.source.album,
            artworkUrl: entry.source.artworkUrl,
            durationMs: durationMs === null ? null : Math.max(0, durationMs - startMs),
          }),
        };
      });
    });

    const load = Effect.fn("load")(function* (entry: QueueEntry, positionMs: number) {
      const startMs = Math.max(0, Math.round(positionMs));
      const stream = yield* prepare(entry, startMs);
      if (Option.isNone(stream)) return yield* report("failed", entry.id, startMs);

      local.loaded = Option.some(stream.value.loaded);
      local.next = Option.none();
      local.replaced = Option.none();
      local.played = Option.none();
      yield* command("playing", output.load(stream.value.media));
    });

    // A new `load` between two entries gives a gap, so the device gets the next entry before
    const loadNext = Effect.gen(function* () {
      const { entry, next } = yield* SubscriptionRef.get(desired);
      const handOver = output.loadNext;
      const queued = Option.getOrUndefined(local.next);
      const current = Option.getOrUndefined(local.loaded)?.entryId;
      if (handOver === undefined || current === undefined || current !== entry?.id) return;
      if (next?.id === queued?.entryId) return;

      const stream = next === undefined ? Option.none() : yield* prepare(next, 0);
      local.replaced = local.next;
      local.next = Option.map(stream, (prepared) => prepared.loaded);
      if (Option.isSome(stream)) return yield* handOver(stream.value.media);
      if (queued !== undefined) yield* handOver(null);
    });

    // Members leave first, so that they do not play the next stream
    const joinMembers = Effect.fn("joinMembers")(function* (group: ReadonlyArray<OutputId>) {
      for (const [id, memberScope] of joined) {
        if (group.includes(id)) continue;
        joined.delete(id);
        yield* Scope.close(memberScope, Exit.void);
      }
      const join = Effect.fn("join")(function* (id: OutputId) {
        const memberScope = yield* Scope.fork(runScope);
        const exit = yield* outputs
          .join(id, options.outputId, {
            taken: options.memberTaken(id),
          })
          .pipe(Scope.provide(memberScope), Effect.exit);
        if (Exit.isFailure(exit)) {
          yield* Scope.close(memberScope, exit);
          yield* Effect.logWarning("Cannot join the group", exit.cause).pipe(
            Effect.annotateLogs("outputId", id),
          );
          return yield* options.memberTaken(id);
        }
        joined.set(id, memberScope);
        yield* exit.value.left.pipe(
          Effect.andThen(options.memberTaken(id)),
          Effect.forkIn(memberScope),
        );
      });
      yield* Effect.forEach(
        group.filter((id) => !joined.has(id)),
        join,
        { concurrency: "unbounded", discard: true },
      );
    });

    // The group plays the stream of the device, so the renderer gets no members
    const timedDesired = ({ playback, entries }: UrlDesired) =>
      new TimedDesired({ playback: new Playback({ ...playback, group: [] }), entries });

    // The live stream replaces the item. The device stops the item when it loads the stream, so
    // the renderer starts at that position and not where the session is when the stream plays.
    const startLive = Effect.fn("startLive")(function* (current: UrlDesired) {
      const now = yield* Clock.currentTimeMillis;
      const positionMs = positionAt(current.playback, now);
      const stopped = new Playback({ ...current.playback, positionMs, at: now, rate: 0 });
      local.loaded = Option.none();
      local.next = Option.none();
      local.replaced = Option.none();
      local.played = Option.none();
      local.expected = Option.none();
      const liveScope = yield* Scope.fork(runScope);
      const driver = yield* driveTimedOutputs({
        desired: timedDesired(new UrlDesired({ ...current, playback: stopped })),
        report: options.report,
        open: () =>
          openLiveStream(output, streamOrigin, "Dyad").pipe(Effect.provideContext(services)),
        closePaused: true,
      }).pipe(Scope.provide(liveScope), Effect.provideContext(services));
      local.live = Option.some(new Live({ driver, scope: liveScope }));
      rendering.on = true;
    });

    // The device loads the entry again at the position of the session
    const stopLive = Effect.gen(function* () {
      if (Option.isNone(local.live)) return;
      const { scope: liveScope } = local.live.value;
      local.live = Option.none();
      local.revision = -1;
      rendering.on = false;
      yield* Scope.close(liveScope, Exit.void);
    });

    // A desired state with the same revision and entry only moves the anchor
    const applyQueue = Effect.gen(function* () {
      const { playback, entry } = yield* SubscriptionRef.get(desired);
      const loaded = Option.getOrUndefined(local.loaded);
      const status = Option.getOrUndefined(local.status);
      if (playback.revision === local.revision && entry?.id === loaded?.entryId) return;
      local.revision = playback.revision;

      if (playback.state === "stopped" || entry === undefined) {
        if (loaded === undefined) return;
        local.loaded = Option.none();
        local.next = Option.none();
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

    const apply = Effect.gen(function* () {
      const current = yield* SubscriptionRef.get(desired);
      yield* joinMembers(current.playback.group);
      if (live && rendersTransitions(current.playback)) {
        if (Option.isSome(local.live)) {
          return yield* local.live.value.driver.desire(timedDesired(current));
        }
        return yield* startLive(current);
      }
      yield* stopLive;
      yield* applyQueue;
      yield* loadNext;
    });

    // Another controller plays its own media, for example the Sonos app
    const foreign = (status: UrlStatus) =>
      status.state === "playing" &&
      status.url !== null &&
      !status.url.startsWith(`${streamOrigin}/stream/`) &&
      !status.url.startsWith(`${streamOrigin}/live/`);

    const observe = Effect.fn("observe")(function* (status: UrlStatus) {
      const now = yield* Clock.currentTimeMillis;
      local.status = Option.some(status);
      // The live stream follows the device itself
      if (Option.isSome(local.live)) {
        if (foreign(status)) yield* options.taken;
        return;
      }
      const next = Option.getOrUndefined(local.next);
      if (next !== undefined && status.url === next.url) {
        local.loaded = Option.some(new Loaded({ ...next, loadedAt: now }));
        local.next = Option.none();
        local.replaced = Option.none();
        local.played = Option.none();
        local.expected = Option.none();
      }
      const loaded = Option.getOrUndefined(local.loaded);
      if (loaded === undefined) return;

      // The loaded entry ended, and the session loads its new next entry
      if (status.url !== null && status.url === Option.getOrUndefined(local.replaced)?.url) {
        local.loaded = Option.none();
        local.next = Option.none();
        local.replaced = Option.none();
        return yield* report("ended", loaded.entryId, loaded.durationMs ?? loaded.startMs);
      }

      if (Option.isSome(local.expected)) {
        const expected = local.expected.value;
        const follows = status.state === expected.state && status.url === loaded.url;
        if (!follows && now < expected.until) return;
        local.expected = Option.none();
      }

      if (status.url !== loaded.url) {
        if (foreign(status)) return yield* options.taken;
        // A Sonos queue that ends goes back to its first item
        if (status.state !== "stopped") return;
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
    /** The renderer plays the session, so the device sends no reports while an entry plays */
    rendering: () => rendering.on,
    /**
     * With `stop`, the device stops first. Without, another controller uses it now. Gives the
     * fiber that closes.
     */
    close: (stop: boolean) =>
      Effect.sync(() => {
        closing.stop = stop;
      }).pipe(Effect.andThen(Fiber.interrupt(fiber)), Effect.forkIn(scope)),
  };
});

export type UrlDriver = Effect.Success<ReturnType<typeof driveUrlOutput>>;
