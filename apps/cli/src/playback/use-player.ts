import {
  PlayQueue,
  ServerConnection,
  addToQueue,
  clearQueue,
  currentEntry,
  cycleRepeat,
  emptyQueue,
  jumpTo,
  pausePlay,
  playList,
  playNext,
  queueEntry,
  queueOf,
  removeEntry,
  reportPlay,
  resumePlay,
  sessionOf,
  startPlay,
  step,
  titleOf,
  toggleShuffle,
} from "@dyad/client-runtime";
import type { CurrentPlay, SavedSession } from "@dyad/client-runtime";
import { PlaybackUnavailable } from "@dyad/domain";
import type { PlayContext, SourceSummary } from "@dyad/domain";
import { NowPlaying } from "@dyad/plugin/client";
import type { Audio } from "@opentui/core";
import {
  Cause,
  Clock,
  Effect,
  Fiber,
  Option,
  Random,
  Schedule,
  Schema,
  SubscriptionRef,
} from "effect";
import { FetchHttpClient } from "effect/http";
import { useEffect, useRef, useState } from "react";

import { describeFailure } from "../log.ts";
import { openTrack } from "./player.ts";
import type { Track } from "./player.ts";

const now = () => Effect.runSync(Clock.currentTimeMillis);

const volumeStep = 0.05;
const seekStepMs = 10_000;
// Like most players, `b` first goes back to the start of the current source
const restartAfterMs = 3000;

// The status text stays until the next play, so that the user can read why nothing plays
const failureText = (cause: Cause.Cause<unknown>, title: string) => {
  const error = Cause.findErrorOption(cause);
  if (Option.isNone(error) || !Schema.is(PlaybackUnavailable)(error.value)) {
    return `Cannot play ${title}`;
  }

  if (error.value.reason === "account_required") return `Link an account to play ${title}`;
  if (error.value.reason === "not_found") return `${title} is no longer available`;
  return `Cannot play ${title}`;
};

export function usePlayer(props: {
  readonly audio: Audio;
  readonly serverUrl: string;
  readonly connection: typeof ServerConnection.Service | null;
  /** The session to start with. The app can start again after an error, with a newer session. */
  readonly restore: () => Option.Option<SavedSession>;
  readonly save: (session: SavedSession) => Effect.Effect<void>;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly onPlayRecorded: () => void;
  /** Client plugins, such as the Discord presence, read the playback from it */
  readonly nowPlaying: SubscriptionRef.SubscriptionRef<NowPlaying | null>;
}) {
  const [saved] = useState(props.restore);
  const [queue, setQueue] = useState(() =>
    Option.match(saved, { onNone: () => emptyQueue, onSome: queueOf }),
  );
  const [volume, setVolume] = useState(() =>
    Option.match(saved, { onNone: () => 1, onSome: (session) => session.volume }),
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

    return reportPlay(play, completed).pipe(
      Effect.provideService(ServerConnection, props.connection),
      Effect.tap(() => Effect.sync(props.onPlayRecorded)),
      Effect.tapCause((cause) => Effect.logWarning("Cannot report a play", describeFailure(cause))),
      Effect.ignore,
    );
  };

  const stop = () => {
    if (fiber.current !== null) Effect.runFork(Fiber.interrupt(fiber.current));
    fiber.current = null;
    track.current = null;
    return finishPlay(false);
  };

  // The audio must stop with the player, for example when the error screen replaces the app
  useEffect(
    () => () => {
      props.run(stop());
      Effect.runSync(SubscriptionRef.set(props.nowPlaying, null));
    },
    [],
  );

  const start = (next: PlayQueue) => {
    props.run(stop());
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
    currentPlay.current = startPlay(entry, now());

    const play = Effect.gen(function* () {
      const opened = yield* openTrack(props.audio, props.serverUrl, entry.source.id);
      track.current = opened;
      setState((current) => (current === "loading" ? "playing" : current));
      yield* opened.ended;
    });

    const ended = Effect.sync(() => {
      fiber.current = null;
      track.current = null;
      props.run(finishPlay(true));
      advance("end");
    });

    // A failed play is not a choice of the user, so it must not count as a skip
    const failed = (cause: Cause.Cause<unknown>) =>
      Effect.gen(function* () {
        yield* Effect.logWarning("Cannot play", describeFailure(cause)).pipe(
          Effect.annotateLogs({ sourceId: entry.source.id, provider: entry.source.provider }),
        );
        fiber.current = null;
        track.current = null;
        currentPlay.current = null;
        setState("stopped");
        setError(failureText(cause, titleOf(entry.source)));
      });

    fiber.current = props.run(
      Effect.scoped(play).pipe(
        Effect.provideService(ServerConnection, connection),
        Effect.provide(FetchHttpClient.layer),
        Effect.matchCauseEffect({
          onSuccess: () => ended,
          onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? Effect.void : failed(cause)),
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
      playing.seek(Math.max(0, ms)).pipe(
        Effect.andThen(
          Effect.sync(() => {
            setTick((t) => t + 1);
            publishNowPlaying();
          }),
        ),
      ),
    );
  };

  const position = () => track.current?.position() ?? 0;

  // Some providers, such as Bandcamp, give no duration before playback
  const durationMs = () => current?.source.durationMs ?? track.current?.durationMs() ?? null;

  const publishNowPlaying = () => {
    const entry = currentEntry(queueRef.current);
    const nowPlaying =
      entry === undefined || state === "stopped"
        ? null
        : new NowPlaying({
            source: entry.source,
            state: state === "paused" ? "paused" : "playing",
            positionMs: position(),
            at: now(),
            durationMs: durationMs(),
          });
    Effect.runSync(SubscriptionRef.set(props.nowPlaying, nowPlaying));
  };

  // While the next source loads, plugins keep the previous one, so that a skip is one change
  useEffect(() => {
    if (state !== "loading") publishNowPlaying();
  }, [state, current?.key]);

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

    const play = currentPlay.current;
    if (state === "paused") {
      props.audio.start();
      setState("playing");
      if (play !== null) currentPlay.current = resumePlay(play, now());
      return;
    }

    props.audio.stop();
    setState("paused");
    if (play !== null) currentPlay.current = pausePlay(play, now());
  };

  const setVolumeTo = (value: number) => {
    // Rounding removes the float error of many steps, so that the ends stay reachable
    setVolume(Math.round(Math.min(1, Math.max(0, value)) * 100) / 100);
  };

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
    shuffleList: (sources: ReadonlyArray<SourceSummary>, context: typeof PlayContext.Type) => {
      const index = Effect.runSync(Random.nextIntBetween(0, sources.length, { halfOpen: true }));
      const shuffled = new PlayQueue({ ...queueRef.current, shuffle: true });
      start(playList(shuffled, sources, index, context));
    },
    playEntry: (index: number) => start(jumpTo(queueRef.current, index)),
    playNext: (source: SourceSummary, context: typeof PlayContext.Type) =>
      commit(playNext(queueRef.current, queueEntry(source, context))),
    addToQueue: (sources: ReadonlyArray<SourceSummary>, context: typeof PlayContext.Type) =>
      commit(
        addToQueue(
          queueRef.current,
          sources.map((source) => queueEntry(source, context)),
        ),
      ),
    remove,
    clear: () => commit(clearQueue(queueRef.current)),
    next: () => advance("skip"),
    previous,
    togglePause,
    seekTo,
    seekBy: (deltaMs: number) => seekTo(position() + deltaMs),
    seekStepMs,
    setVolume: setVolumeTo,
    changeVolume: (direction: 1 | -1) => setVolumeTo(volume + direction * volumeStep),
    toggleShuffle: () => commit(toggleShuffle(queueRef.current)),
    cycleRepeat: () => commit(cycleRepeat(queueRef.current)),
    /** Reports the current play and saves the session */
    quit: () => stop().pipe(Effect.andThen(props.save(sessionOf(queueRef.current, volume)))),
  };
}
