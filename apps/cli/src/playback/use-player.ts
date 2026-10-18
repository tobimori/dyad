import {
  currentEntryOf,
  deviceOutputId,
  isTransportCommand,
  positionOf,
} from "@dyad/client-runtime";
import type { ListenFeed, SessionClient } from "@dyad/client-runtime";
import { SessionCommand, skipSeekTarget } from "@dyad/domain";
import type { OutputId, PlayContext, SourceSegment, SourceSummary } from "@dyad/domain";
import { Clock, Effect, Fiber, Random, Schedule, Stream, SubscriptionRef } from "effect";
import { useEffect, useState } from "react";

import type { Engine } from "./engine.ts";

const now = () => Effect.runSync(Clock.currentTimeMillis);

const volumeStep = 0.05;
const seekStepMs = 10_000;
// The most entries that one command can add
const maxEntries = 10_000;

const nextRepeatMode = { off: "all", all: "one", one: "off" } as const;

const failureTexts = {
  nothing_to_play: "Nothing to play",
  output_unavailable: "The output is offline. Press o to choose one.",
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

/** The view of the session. It renders again on each change. */
export function useSessionView(
  session: typeof SessionClient.Service,
  run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>,
) {
  const [view, setView] = useState(() => SubscriptionRef.getUnsafe(session.view));

  useEffect(() => {
    const following = run(
      Stream.runForEach(SubscriptionRef.changes(session.view), (next) =>
        Effect.sync(() => setView(next)),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(following));
    };
  }, []);

  return view;
}

/** Shows the server session and sends the user's commands to it */
export function usePlayer(props: {
  readonly session: typeof SessionClient.Service;
  /** `null` when this device only controls */
  readonly engine: typeof Engine.Service | null;
  /** The audio of a timed output that plays elsewhere, for the visualizer */
  readonly listen: ListenFeed;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly notify: (message: string) => void;
  /** A quiet note */
  readonly inform: (message: string) => void;
}) {
  const view = useSessionView(props.session, props.run);
  // A playback failure on this device. It stays until the next entry starts.
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const engine = props.engine?.run(props.session, {
      onFailure: setError,
      onNotice: props.inform,
    });
    if (engine === undefined) return;
    const playing = props.run(engine);
    return () => {
      Effect.runFork(Fiber.interrupt(playing));
    };
  }, []);

  const playback = view.playback;
  const entries = view.entries;
  const current = currentEntryOf(view);
  const currentIndex = current === undefined ? null : entries.indexOf(current);
  const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
  const volumeTarget =
    playback.outputId ?? (view.outputs.some((output) => output.id === own) ? own : null);
  const volumeOutput = view.outputs.find((output) => output.id === volumeTarget);
  const volume = volumeOutput?.volume ?? null;

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

  const send = (command: typeof SessionCommand.Type) => {
    // Offline, only the device that plays can change its own audio
    if (!view.connected && isTransportCommand(command) && props.engine?.controlOffline(command)) {
      return;
    }

    props.run(
      props.session.send(command).pipe(
        Effect.catchTags({
          SessionOffline: () => Effect.sync(() => props.notify("The server is offline")),
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
  };

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

  const setOutputVolume = (outputId: OutputId, value: number) => {
    // Rounding removes the float error of many steps, so that the ends stay reachable
    const rounded = Math.round(Math.min(1, Math.max(0, value)) * 100) / 100;
    send(SessionCommand.cases.SetVolume.make({ outputId, volume: rounded }));
  };

  const setVolumeTo = (value: number) => {
    if (volumeTarget !== null) setOutputVolume(volumeTarget, value);
  };

  const playList = (
    sources: ReadonlyArray<SourceSummary>,
    index: number,
    context: typeof PlayContext.Type,
    shuffle: boolean,
    reasons: Readonly<Record<string, string>> = {},
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
        reasons,
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

  // Offline, the view shows what this device plays, or the last state of another output
  const offlineText = () => {
    if (view.connected) return null;
    return props.engine !== null && playback.outputId === own && !view.superseded
      ? "Offline, playing downloaded audio"
      : "Offline, showing the last known state";
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
    autoplay: playback.autoplay,
    volume,
    muted: volumeOutput?.muted ?? false,
    error,
    /** The output stopped answering, or a URL output did not start the stream */
    lost: playback.lost && playback.state !== "stopped",
    /** `null` while connected */
    offline: offlineText(),
    position,
    durationMs,
    /** `null` while the audio plays on another device */
    tap: () => {
      if (current === undefined) return null;
      const own = props.engine?.tap(current.id) ?? null;
      const output = view.outputs.find((candidate) => candidate.id === playback.outputId);
      // The server renders groups, timed outputs and the live stream of a Sonos with transitions
      const rendered =
        playback.group.length > 0 ||
        output?.kind === "timed" ||
        (output?.kind === "url" && (playback.crossfadeSeconds > 0 || playback.djStyle !== null));
      return own ?? (rendered ? props.listen : null);
    },
    /** `null` while the audio plays on another device */
    quality: () => (current === undefined ? null : (props.engine?.quality(current.id) ?? null)),
    /** `reasons`: why a radio suggests each source, by source ID */
    playList: (
      sources: ReadonlyArray<SourceSummary>,
      index: number,
      context: typeof PlayContext.Type,
      reasons?: Readonly<Record<string, string>>,
    ) => playList(sources, index, context, playback.shuffle, reasons),
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
    /** `segments`: of the current source, so that a skip stays inside a DJ set */
    skip: (direction: 1 | -1, segments: ReadonlyArray<SourceSegment>) => {
      if (current === undefined) return;
      const target = skipSeekTarget(segments, position(), direction);
      if (target !== undefined) seekTo(target);
      else send(SessionCommand.cases.Skip.make({ fromEntryId: current.id, direction }));
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
    setOutputVolume,
    /** Plays the session on `outputId` from the current position */
    transfer: (outputId: OutputId) =>
      send(SessionCommand.cases.Transfer.make({ outputId, play: null })),
    /** Plays the session on all `outputIds` in sync */
    group: (outputIds: readonly [OutputId, ...Array<OutputId>]) =>
      send(SessionCommand.cases.SetGroup.make({ outputIds })),
    toggleShuffle: () => send(SessionCommand.cases.SetShuffle.make({ on: !playback.shuffle })),
    cycleRepeat: () =>
      send(SessionCommand.cases.SetRepeat.make({ mode: nextRepeatMode[playback.repeat] })),
    toggleAutoplay: () => send(SessionCommand.cases.SetAutoplay.make({ on: !playback.autoplay })),
    /** The session pauses when this device plays it, so that it does not look like it plays on */
    quit: () =>
      playback.outputId === own && playback.state === "playing"
        ? props.session.send(SessionCommand.cases.Pause.make({})).pipe(Effect.ignore)
        : Effect.void,
  };
}
