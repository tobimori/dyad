import {
  currentEntryOf,
  deviceOutputId,
  isTransportCommand,
  positionOf,
} from "@dyad/client-runtime";
import type { SessionClient } from "@dyad/client-runtime";
import { SessionCommand } from "@dyad/domain";
import type { PlayContext, SourceSummary } from "@dyad/domain";
import { Clock, Effect, Fiber, Random, Schedule, Stream, SubscriptionRef } from "effect";
import { useEffect, useState } from "react";

import type { Engine } from "./engine.ts";

const now = () => Effect.runSync(Clock.currentTimeMillis);

const volumeStep = 0.05;
const seekStepMs = 10_000;
// Like most players, `b` first goes back to the start of the current source
const restartAfterMs = 3000;
// The most entries that one command can add
const maxEntries = 10_000;

const nextRepeatMode = { off: "all", all: "one", one: "off" } as const;

const failureTexts = {
  nothing_to_play: "Nothing to play",
  output_unavailable: "No device plays this session",
  queue_full: "The queue is full",
  // Another client changed the queue or the transport first
  entry_not_found: null,
  stale_queue: null,
};

// At most `maxEntries` sources around `index`, so that a long list still plays
const window = (sources: ReadonlyArray<SourceSummary>, index: number) => {
  const start = Math.max(0, Math.min(index, sources.length - maxEntries));
  return {
    sourceIds: sources.slice(start, start + maxEntries).map((source) => source.id),
    index: index - start,
  };
};

/** Shows the server session and sends the user's commands to it */
export function usePlayer(props: {
  readonly session: typeof SessionClient.Service;
  /** `null` when this device only controls */
  readonly engine: typeof Engine.Service | null;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly notify: (message: string) => void;
}) {
  const [view, setView] = useState(() => SubscriptionRef.getUnsafe(props.session.view));
  // A playback failure on this device. It stays until the next entry starts.
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const following = props.run(
      Stream.runForEach(SubscriptionRef.changes(props.session.view), (next) =>
        Effect.sync(() => setView(next)),
      ),
    );
    const engine = props.engine?.run(props.session, setError);
    const playing = engine === undefined ? null : props.run(engine);
    return () => {
      Effect.runFork(Fiber.interrupt(following));
      if (playing !== null) Effect.runFork(Fiber.interrupt(playing));
    };
  }, []);

  const playback = view.playback;
  const entries = view.entries;
  const current = currentEntryOf(view);
  const currentIndex = current === undefined ? null : entries.indexOf(current);
  const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
  const volumeTarget =
    playback.outputId ?? (view.outputs.some((output) => output.id === own) ? own : null);
  const volume = view.outputs.find((output) => output.id === volumeTarget)?.volume ?? null;

  // The position moves without events, so the display polls it
  useEffect(() => {
    if (playback.state !== "playing") return;
    const ticks = Effect.runFork(
      Effect.sync(() => setTick((tick) => tick + 1)).pipe(
        Effect.repeat(Schedule.spaced("500 millis")),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(ticks));
    };
  }, [playback.state]);

  const send = (command: typeof SessionCommand.Type) =>
    props.run(
      props.session.send(command).pipe(
        Effect.catchTags({
          // Offline, transport commands change only this device
          SessionOffline: () =>
            Effect.sync(() => {
              if (!isTransportCommand(command)) props.notify("The server is offline");
            }),
          SessionCommandFailed: (failure) =>
            Effect.sync(() => {
              const text = failureTexts[failure.reason];
              if (text !== null) props.notify(text);
            }),
          Unauthorized: () =>
            Effect.sync(() => props.notify("The server does not accept this device")),
        }),
      ),
    );

  const position = () => {
    if (current === undefined) return 0;
    return props.engine?.position(current.id) ?? positionOf(view, now());
  };

  const durationMs = () =>
    current === undefined
      ? null
      : (current.source.durationMs ?? props.engine?.durationMs(current.id) ?? null);

  const seekTo = (ms: number) => {
    if (current === undefined) return;
    const end = durationMs();
    const positionMs = Math.max(0, end === null ? ms : Math.min(ms, end));
    send(SessionCommand.cases.Seek.make({ entryId: current.id, positionMs }));
  };

  const setVolumeTo = (value: number) => {
    if (volumeTarget === null) return;
    // Rounding removes the float error of many steps, so that the ends stay reachable
    const rounded = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    send(SessionCommand.cases.SetVolume.make({ outputId: volumeTarget, volume: rounded }));
  };

  const playList = (
    sources: ReadonlyArray<SourceSummary>,
    index: number,
    context: typeof PlayContext.Type,
    shuffle: boolean,
  ) => {
    const selected = window(sources, index);
    const [first, ...others] = selected.sourceIds;
    if (first === undefined) return;
    send(
      SessionCommand.cases.Play.make({
        sourceIds: [first, ...others],
        index: selected.index,
        context,
        shuffle,
      }),
    );
  };

  const enqueue = (
    sources: ReadonlyArray<SourceSummary>,
    context: typeof PlayContext.Type,
    after: "current" | "end",
  ) => {
    const [first, ...others] = sources.slice(0, maxEntries).map((source) => source.id);
    if (first === undefined) return;
    send(SessionCommand.cases.Enqueue.make({ sourceIds: [first, ...others], context, after }));
  };

  // A loading state on another output; this device shows its own audio
  const loading =
    playback.state === "playing" &&
    playback.rate === 0 &&
    (current === undefined || props.engine?.position(current.id) == null);

  return {
    entries,
    currentIndex,
    current,
    state: loading ? ("loading" as const) : playback.state,
    shuffle: playback.shuffle,
    repeat: playback.repeat,
    volume,
    error,
    /** The output stopped answering */
    lost: playback.lost && playback.state === "playing",
    position,
    durationMs,
    /** `null` while the audio plays on another device */
    playList: (
      sources: ReadonlyArray<SourceSummary>,
      index: number,
      context: typeof PlayContext.Type,
    ) => playList(sources, index, context, playback.shuffle),
    shuffleList: (sources: ReadonlyArray<SourceSummary>, context: typeof PlayContext.Type) => {
      const index = Effect.runSync(Random.nextIntBetween(0, sources.length, { halfOpen: true }));
      playList(sources, index, context, true);
    },
    playEntry: (index: number) => {
      const entry = entries[index];
      if (entry !== undefined)
        send(SessionCommand.cases.JumpTo.make({ entryId: entry.id, positionMs: 0 }));
    },
    playNext: (source: SourceSummary, context: typeof PlayContext.Type) =>
      enqueue([source], context, "current"),
    addToQueue: (sources: ReadonlyArray<SourceSummary>, context: typeof PlayContext.Type) =>
      enqueue(sources, context, "end"),
    remove: (index: number) => {
      const entry = entries[index];
      if (entry !== undefined) send(SessionCommand.cases.Remove.make({ entryIds: [entry.id] }));
    },
    clear: () => send(SessionCommand.cases.Clear.make({ keepCurrent: true })),
    next: () => {
      if (current === undefined) return;
      send(SessionCommand.cases.Skip.make({ fromEntryId: current.id, direction: 1 }));
    },
    previous: () => {
      if (current === undefined) return;
      if (position() > restartAfterMs) seekTo(0);
      else send(SessionCommand.cases.Skip.make({ fromEntryId: current.id, direction: -1 }));
    },
    togglePause: () =>
      send(
        playback.state === "playing"
          ? SessionCommand.cases.Pause.make({})
          : SessionCommand.cases.Resume.make({}),
      ),
    seekTo,
    seekBy: (deltaMs: number) => seekTo(position() + deltaMs),
    seekStepMs,
    setVolume: setVolumeTo,
    changeVolume: (direction: 1 | -1) => setVolumeTo((volume ?? 0) + direction * volumeStep),
    toggleShuffle: () => send(SessionCommand.cases.SetShuffle.make({ on: !playback.shuffle })),
    cycleRepeat: () =>
      send(SessionCommand.cases.SetRepeat.make({ mode: nextRepeatMode[playback.repeat] })),
    /** The session pauses when this device plays it, so that it does not look like it plays on */
    quit: () =>
      playback.outputId === own && playback.state === "playing"
        ? props.session.send(SessionCommand.cases.Pause.make({})).pipe(Effect.ignore)
        : Effect.void,
  };
}
