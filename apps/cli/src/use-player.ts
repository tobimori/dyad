import { ServerConnection } from "@dyad/client-runtime";
import type { PlayContext, SourceSummary } from "@dyad/domain";
import type { Audio } from "@opentui/core";
import { Clock, Data, Effect, Fiber, Option, Schedule } from "effect";
import { FetchHttpClient } from "effect/http";
import { useEffect, useRef, useState } from "react";

import { titleOf } from "./format.ts";
import { openTrack } from "./player.ts";
import type { Track } from "./player.ts";
import {
  addToQueue,
  clearQueue,
  currentEntry,
  cycleRepeat,
  emptyQueue,
  jumpTo,
  playList,
  playNext,
  queueEntry,
  removeEntry,
  step,
  toggleShuffle,
} from "./queue.ts";
import type { PlayQueue } from "./queue.ts";
import { queueOf, sessionOf } from "./session.ts";
import type { SavedSession } from "./session.ts";

// The play that the CLI reports with `recordPlay` when it ends
class CurrentPlay extends Data.Class<{
  readonly sourceId: string;
  readonly context: typeof PlayContext.Type;
  readonly startedAt: number;
  /** Played time before the last resume */
  readonly playedMs: number;
  /** `null` while paused */
  readonly resumedAt: number | null;
}> {}

const now = () => Effect.runSync(Clock.currentTimeMillis);

const volumeStep = 0.05;
const seekStepMs = 10_000;
// Like most players, `b` first goes back to the start of the current source
const restartAfterMs = 3000;

/** The queue, the source that plays and the reports of plays */
export function usePlayer(props: {
  readonly audio: Audio;
  readonly serverUrl: string;
  readonly connection: typeof ServerConnection.Service | null;
  readonly saved: Option.Option<SavedSession>;
  readonly save: (session: SavedSession) => Effect.Effect<void>;
  readonly onPlayRecorded: () => void;
}) {
  const [queue, setQueue] = useState(() =>
    Option.match(props.saved, { onNone: () => emptyQueue, onSome: queueOf }),
  );
  const [volume, setVolume] = useState(() =>
    Option.match(props.saved, { onNone: () => 1, onSome: (saved) => saved.volume }),
  );
  // A restored session waits for `space`, so it starts as paused
  const [state, setState] = useState<"stopped" | "loading" | "playing" | "paused">(() =>
    queue.current === null ? "stopped" : "paused",
  );
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  // Callbacks of playback fibers run after later renders, so they read the queue from a ref
  const queueRef = useRef(queue);
  const fiber = useRef<Fiber.Fiber<void> | null>(null);
  const track = useRef<Track | null>(null);
  const currentPlay = useRef<CurrentPlay | null>(null);

  const current = currentEntry(queue);

  const commit = (next: PlayQueue) => {
    queueRef.current = next;
    setQueue(next);
  };

  useEffect(() => {
    props.audio.setMasterVolume(volume);
  }, [volume]);

  // The position comes from the audio stream, so the display polls it
  useEffect(() => {
    if (state !== "playing") return;
    const ticks = Effect.runFork(
      Effect.sync(() => setTick((tick) => tick + 1)).pipe(
        Effect.repeat(Schedule.spaced("500 millis")),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(ticks));
    };
  }, [state]);

  useEffect(() => {
    const saving = Effect.runFork(
      Effect.sleep("1 second").pipe(Effect.andThen(props.save(sessionOf(queue, volume)))),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(saving));
    };
  }, [queue, volume]);

  // Returns the report, so that quitting can wait for it
  const finishPlay = (completed: boolean) => {
    const play = currentPlay.current;
    currentPlay.current = null;
    if (play === null || props.connection === null) return Effect.void;

    const resumedMs = play.resumedAt === null ? 0 : now() - play.resumedAt;
    return props.connection
      .recordPlay({
        sourceId: play.sourceId,
        startedAt: play.startedAt,
        playedMs: play.playedMs + resumedMs,
        completed,
        context: play.context,
      })
      .pipe(
        Effect.tap(() => Effect.sync(props.onPlayRecorded)),
        Effect.ignore,
      );
  };

  const stop = () => {
    if (fiber.current !== null) Effect.runFork(Fiber.interrupt(fiber.current));
    fiber.current = null;
    track.current = null;
    return finishPlay(false);
  };

  const start = (next: PlayQueue) => {
    Effect.runFork(stop());
    commit(next);

    const entry = currentEntry(next);
    const connection = props.connection;
    if (entry === undefined || connection === null) {
      setState("stopped");
      return;
    }

    props.audio.start();
    setState("loading");
    setError(null);

    const startedAt = now();
    currentPlay.current = new CurrentPlay({
      sourceId: entry.source.id,
      context: entry.context,
      startedAt,
      playedMs: 0,
      resumedAt: startedAt,
    });

    const play = Effect.gen(function* () {
      const opened = yield* openTrack(props.audio, props.serverUrl, entry.source.id);
      track.current = opened;
      setState((current) => (current === "loading" ? "playing" : current));
      yield* opened.ended;
    });

    fiber.current = Effect.runFork(
      Effect.scoped(play).pipe(
        Effect.provideService(ServerConnection, connection),
        Effect.provide(FetchHttpClient.layer),
        Effect.matchEffect({
          onSuccess: () =>
            Effect.sync(() => {
              fiber.current = null;
              track.current = null;
              Effect.runFork(finishPlay(true));
              advance("end");
            }),
          // A failed play is not a choice of the user, so it must not count as a skip
          onFailure: () =>
            Effect.sync(() => {
              fiber.current = null;
              track.current = null;
              currentPlay.current = null;
              setState("stopped");
              setError(`Cannot play ${titleOf(entry.source)}`);
            }),
        }),
      ),
    );
  };

  const advance = (reason: "skip" | "end") => {
    const next = step(queueRef.current, 1, reason);
    if (next !== undefined) {
      start(next);
      return;
    }
    if (reason === "end") setState("stopped");
  };

  const seekTo = (ms: number) => {
    const playing = track.current;
    if (playing === null) return;
    Effect.runFork(
      playing.seek(Math.max(0, ms)).pipe(Effect.andThen(Effect.sync(() => setTick((t) => t + 1)))),
    );
  };

  const position = () => track.current?.position() ?? 0;

  // Some providers, such as Bandcamp, give no duration before playback
  const durationMs = () => current?.source.durationMs ?? track.current?.durationMs() ?? null;

  const previous = () => {
    const next = step(queueRef.current, -1, "skip");
    if (next === undefined || position() > restartAfterMs) {
      seekTo(0);
      return;
    }
    start(next);
  };

  const togglePause = () => {
    // Nothing is loaded after a restore or at the end of the queue
    if (fiber.current === null) {
      const queued = queueRef.current;
      const next = queued.current === null ? step(queued, 1, "skip") : queued;
      if (next !== undefined) start(next);
      return;
    }

    const time = now();
    const play = currentPlay.current;
    if (state === "paused") {
      props.audio.start();
      setState("playing");
      if (play !== null) currentPlay.current = new CurrentPlay({ ...play, resumedAt: time });
      return;
    }

    props.audio.stop();
    setState("paused");
    if (play === null) return;
    const resumedMs = play.resumedAt === null ? 0 : time - play.resumedAt;
    currentPlay.current = new CurrentPlay({
      ...play,
      playedMs: play.playedMs + resumedMs,
      resumedAt: null,
    });
  };

  const changeVolume = (direction: 1 | -1) =>
    setVolume((current) => {
      const next = Math.min(1, Math.max(0, current + direction * volumeStep));
      // Rounding removes the float error of many steps, so that the ends stay reachable
      return Math.round(next * 100) / 100;
    });

  const remove = (index: number) => {
    const next = removeEntry(queueRef.current, index);
    const removesCurrent = queueRef.current.current === index;
    if (!removesCurrent || fiber.current === null) {
      commit(next);
      return;
    }
    start(next);
  };

  return {
    queue,
    state,
    volume,
    error,
    current,
    position,
    durationMs,
    playList: (
      sources: ReadonlyArray<SourceSummary>,
      index: number,
      context: typeof PlayContext.Type,
    ) => start(playList(queueRef.current, sources, index, context)),
    playEntry: (index: number) => start(jumpTo(queueRef.current, index)),
    playNext: (source: SourceSummary, context: typeof PlayContext.Type) =>
      commit(playNext(queueRef.current, queueEntry(source, context))),
    addToQueue: (source: SourceSummary, context: typeof PlayContext.Type) =>
      commit(addToQueue(queueRef.current, queueEntry(source, context))),
    remove,
    clear: () => commit(clearQueue(queueRef.current)),
    next: () => advance("skip"),
    previous,
    togglePause,
    seekBy: (deltaMs: number) => seekTo(position() + deltaMs),
    seekStepMs,
    changeVolume,
    toggleShuffle: () => commit(toggleShuffle(queueRef.current)),
    cycleRepeat: () => commit(cycleRepeat(queueRef.current)),
    /** Reports the current play and saves the session */
    quit: () => stop().pipe(Effect.andThen(props.save(sessionOf(queueRef.current, volume)))),
  };
}
