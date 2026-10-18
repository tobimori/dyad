import { AudioFormat, OutputId, PlaybackCapabilities, positionAt } from "@dyad/domain";
import type { EntryId, Playback, QueueEntry, UserId } from "@dyad/domain";
import { encodeFlac, remuxAudio } from "@dyad/media/node";
import type { MediaStream } from "@dyad/media/node";
import { Loudness } from "@dyad/player";
import { TimedMedia, TimedOutput } from "@dyad/plugin";
import {
  Clock,
  Data,
  Effect,
  Exit,
  FileSystem,
  Option,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";

import { sourceAnalysis } from "./audio-analysis.ts";
import { Outputs } from "./outputs.ts";
import { Receivers } from "./receivers.ts";
import { FilePlayback, choosePlayableSource, providerStream } from "./playback.ts";
import { Ended, EntryFailed, EntryStarted, RenderInput, openSessionRenderer } from "./renderer.ts";
import { OutputReport } from "./url-output.ts";

// RTSP setup of an AirPlay receiver takes about 1 second
const openTimeout = "10 seconds";

// `@dyad/player` decodes only these
const renderCapabilities = new PlaybackCapabilities({
  formats: [
    new AudioFormat({ container: "flac", codec: "flac" }),
    new AudioFormat({ container: "mp3", codec: "mp3" }),
  ],
});

const renderInput = (userId: UserId, entry: QueueEntry) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const sourceId = entry.source.id;
    const { playable, choice } = yield* choosePlayableSource(sourceId, userId, renderCapabilities);
    const convert = (media: string | MediaStream) =>
      choice.operation === "transcode"
        ? encodeFlac(media)
        : remuxAudio(media, choice.format.container);
    const readFile = (path: string) =>
      choice.operation === "direct" ? fs.stream(path) : convert(path);
    const bytes =
      playable instanceof FilePlayback
        ? readFile(playable.path)
        : yield* providerStream(playable, sourceId, 0, convert);
    const analysis = yield* sourceAnalysis(sourceId);
    return new RenderInput<Stream.Error<typeof bytes>>({
      codec: choice.format.codec === "mp3" ? "mp3" : "flac",
      bytes,
      loudness:
        analysis === null
          ? undefined
          : new Loudness({ integrated: analysis.loudness, truePeak: analysis.truePeak }),
    });
  });

/** What the session wants its timed outputs to play */
export class TimedDesired extends Data.Class<{
  readonly playback: Playback;
  /** The current entry, then the entries that follow it in play order */
  readonly entries: ReadonlyArray<QueueEntry>;
}> {}

class Member extends Data.Class<{
  /** As the plugin gives it, without the delay */
  readonly output: TimedOutput;
  readonly delayMs: number;
  readonly scope: Scope.Closeable;
}> {}

// The output plays `delayMs` later than the timeline, so it gets each block that much earlier
const delayed = (output: TimedOutput, delayMs: number) =>
  delayMs === 0
    ? output
    : new TimedOutput({
        ...output,
        leadMs: Math.max(0, output.leadMs - delayMs),
        write: (playAtUs, pcm) => output.write(playAtUs + delayMs * 1000, pcm),
        setMedia: (media) =>
          output.setMedia(
            new TimedMedia({ ...media, startAtUs: media.startAtUs + delayMs * 1000 }),
          ),
      });

/**
 * Makes the timed outputs of a session play it through one renderer, so that they play in sync.
 * Outputs open when the session plays; an output that fails joins again at the next command.
 */
export const driveTimedOutputs = (options: {
  readonly userId: UserId;
  readonly desired: TimedDesired;
  readonly report: (report: OutputReport) => Effect.Effect<void>;
  /** Another session took the output */
  readonly taken: (outputId: OutputId) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const outputs = yield* Outputs;
    const receivers = yield* Receivers;
    const scope = yield* Scope.fork(yield* Effect.scope);
    const services = yield* Effect.context<Effect.Services<ReturnType<typeof renderInput>>>();
    const desired = yield* SubscriptionRef.make(options.desired);
    const renderer = yield* openSessionRenderer((entry) =>
      renderInput(options.userId, entry).pipe(Effect.provideContext(services)),
    ).pipe(Scope.provide(scope));

    const members = new Map<OutputId, Member>();
    // Outputs that failed since the last command
    const failed = new Set<OutputId>();
    const local = {
      // Reports carry the revision of the last desired state that the driver applied
      revision: -1,
      // The renderer plays an epoch
      playing: false,
      // The entry that the last `EntryStarted` made current
      started: Option.none<EntryId>(),
      entries: "",
    };

    const report = (state: OutputReport["state"], entryId: EntryId, positionMs: number) =>
      options.report(new OutputReport({ revision: local.revision, entryId, state, positionMs }));

    const closeMember = (id: OutputId) =>
      Effect.gen(function* () {
        const member = members.get(id);
        if (member === undefined) return;
        members.delete(id);
        yield* renderer.removeOutput(id);
        yield* Scope.close(member.scope, Exit.void);
      });

    const openMember = (id: OutputId) =>
      Effect.gen(function* () {
        const memberScope = yield* Scope.fork(scope);
        const opening = receivers.has(options.userId, id)
          ? receivers.open(options.userId, id)
          : outputs.openTimed(id, {
              userId: options.userId,
              taken: closeMember(id).pipe(Effect.andThen(options.taken(id))),
            });
        const exit = yield* opening.pipe(
          Effect.timeout(openTimeout),
          Scope.provide(memberScope),
          Effect.exit,
        );
        if (Exit.isFailure(exit)) {
          failed.add(id);
          yield* Scope.close(memberScope, exit);
          return yield* Effect.logWarning("Cannot open a timed output", exit.cause).pipe(
            Effect.annotateLogs("outputId", id),
          );
        }
        const delayMs = outputs.delayOf(id);
        members.set(id, new Member({ output: exit.value, delayMs, scope: memberScope }));
        yield* renderer.addOutput(id, delayed(exit.value, delayMs));
      });

    const stall = Effect.gen(function* () {
      const position = yield* renderer.position;
      const { playback } = yield* SubscriptionRef.get(desired);
      const entryId = position?.entryId ?? playback.entryId;
      local.playing = false;
      if (entryId !== null) yield* report("stalled", entryId, position?.positionMs ?? 0);
    });

    const apply = Effect.gen(function* () {
      const { playback, entries } = yield* SubscriptionRef.get(desired);
      // A stopped session releases its receivers, which else show that they play
      const wanted =
        playback.outputId === null || playback.state === "stopped"
          ? []
          : [playback.outputId, ...playback.group];
      yield* Effect.forEach(
        [...members.keys()].filter((id) => !wanted.includes(id)),
        closeMember,
        { discard: true },
      );

      const revised = playback.revision !== local.revision;
      if (revised) failed.clear();
      if (playback.state === "playing") {
        yield* Effect.forEach(
          wanted.filter((id) => !members.has(id) && !failed.has(id)),
          openMember,
          { concurrency: "unbounded", discard: true },
        );
      }

      const order = entries.map((entry) => entry.id).join(" ");
      if (!revised) {
        if (order === local.entries || !local.playing) return;
        local.entries = order;
        return yield* renderer.setQueue(entries);
      }

      const [first] = entries;
      const wasPlaying = local.playing;
      local.playing = false;
      local.entries = order;
      if (playback.state !== "playing" || first === undefined) {
        const position = yield* renderer.pause;
        local.revision = playback.revision;
        // The exact position, which the extrapolated one of the session is not
        if (wasPlaying && playback.state === "paused" && position?.entryId === playback.entryId) {
          yield* report("paused", position.entryId, position.positionMs);
        }
        return;
      }

      if (members.size === 0) {
        local.revision = playback.revision;
        return yield* stall;
      }
      yield* renderer.play(entries, positionAt(playback, yield* Clock.currentTimeMillis));
      local.revision = playback.revision;
      local.playing = true;
    });

    const followEvents = renderer.events.pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          if (event instanceof EntryStarted) {
            local.started = Option.some(event.entryId);
            return yield* report("playing", event.entryId, event.positionMs);
          }
          if (event instanceof EntryFailed) return yield* report("failed", event.entryId, 0);
          if (event instanceof Ended) {
            local.playing = false;
            if (Option.isNone(local.started)) return;
            const ended = new OutputReport({
              revision: local.revision,
              entryId: local.started.value,
              state: "ended",
              positionMs: 0,
            });
            // The session continues with a new transport, also when the revision stays. The
            // report can apply that transport before it returns.
            local.revision = -1;
            return yield* options.report(ended);
          }

          yield* Effect.logWarning("Timed output lost", event.error.reason).pipe(
            Effect.annotateLogs("outputId", event.outputId),
          );
          const id = OutputId.make(event.outputId);
          const member = members.get(id);
          if (member === undefined) return;
          members.delete(id);
          failed.add(id);
          yield* Scope.close(member.scope, Exit.void);
          if (members.size === 0 && local.playing) yield* stall;
        }),
      ),
    );

    // A changed delay takes effect at once, with a flush of that output only
    const applyDelays = Effect.suspend(() =>
      Effect.forEach(
        [...members],
        ([id, member]) => {
          const delayMs = outputs.delayOf(id);
          if (delayMs === member.delayMs) return Effect.void;
          members.set(id, new Member({ ...member, delayMs }));
          return renderer
            .removeOutput(id)
            .pipe(Effect.andThen(renderer.addOutput(id, delayed(member.output, delayMs))));
        },
        { discard: true },
      ),
    );

    // Visualizers of the user follow the output that the session names, with its delay
    yield* renderer.addOutput(
      "listen",
      new TimedOutput({
        leadMs: 0,
        write: (playAtUs, pcm) => {
          const { outputId } = SubscriptionRef.getUnsafe(desired).playback;
          const delayMs = outputId === null ? 0 : outputs.delayOf(outputId);
          return receivers.feed(options.userId, playAtUs + delayMs * 1000, pcm);
        },
        flush: receivers.flushListeners(options.userId),
        setVolume: () => Effect.void,
        setMedia: () => Effect.void,
        closed: Effect.never,
      }),
    );
    yield* Effect.forkIn(followEvents, scope);
    yield* Stream.merge(
      SubscriptionRef.changes(desired).pipe(Stream.as(apply)),
      outputs.changes.pipe(Stream.as(applyDelays)),
    ).pipe(
      Stream.runForEach((effect) => effect),
      Effect.forkIn(scope),
    );

    return {
      desire: (next: TimedDesired) => SubscriptionRef.set(desired, next),
      /** Stops the renderer and closes the outputs */
      close: Scope.close(scope, Exit.void).pipe(Effect.forkDetach, Effect.asVoid),
    };
  });

export type TimedDriver = Effect.Success<ReturnType<typeof driveTimedOutputs>>;
