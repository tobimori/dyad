import {
  Output,
  OutputId,
  Playback,
  SessionCommand,
  SessionEvent,
  applySplices,
  nextEntry,
  positionAt,
} from "@dyad/domain";
import type {
  DeviceId,
  PlaybackCapabilities,
  PlayerResume,
  QueueEntry,
  SourceSummary,
} from "@dyad/domain";
import { NowPlaying } from "@dyad/plugin/client";
import {
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  Layer,
  Option,
  Predicate,
  Schedule,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";

import { ServerConnection } from "./connection.ts";

type Command = typeof SessionCommand.Type;

/** A room in the room list */
export class RoomSummary extends Data.Class<{
  readonly id: OutputId;
  readonly name: string;
  readonly playback: Playback;
  readonly current: SourceSummary | null;
}> {}

/** The client's copy of one room */
export class SessionView extends Data.Class<{
  /** `false` while the client has no stream from the server. The view keeps the last state. */
  readonly connected: boolean;
  /** `null` before the first connection */
  readonly deviceId: DeviceId | null;
  /** Reports of this connection send it */
  readonly generation: number;
  /** A newer connection of this device plays. This client only controls. */
  readonly superseded: boolean;
  /** `null` before the client knows a room */
  readonly room: OutputId | null;
  readonly name: string;
  readonly rooms: ReadonlyArray<RoomSummary>;
  readonly queueVersion: number;
  readonly entries: ReadonlyArray<QueueEntry>;
  /** With the transport commands of this client that the server did not confirm yet */
  readonly playback: Playback;
  /** The last playback from the server */
  readonly confirmed: Playback;
  readonly outputs: ReadonlyArray<Output>;
  /** Server time minus local time */
  readonly clockOffset: number;
}> {}

/** A command needs the server, so it fails at once while the client is offline */
export class SessionOffline extends Data.TaggedError("SessionOffline")<{}> {}

// The stream skipped a queue change, so the client needs a new snapshot
class MissedQueueChange extends Data.TaggedError("MissedQueueChange")<{}> {}

const stoppedPlayback = new Playback({
  state: "stopped",
  entryId: null,
  positionMs: 0,
  at: 0,
  rate: 0,
  revision: 0,
  outputId: null,
  group: [],
  lost: false,
  shuffle: false,
  repeat: "off",
});

const initialView = new SessionView({
  connected: false,
  deviceId: null,
  generation: 0,
  superseded: false,
  room: null,
  name: "",
  rooms: [],
  queueVersion: 0,
  entries: [],
  playback: stoppedPlayback,
  confirmed: stoppedPlayback,
  outputs: [],
  clockOffset: 0,
});

export const deviceOutputId = (deviceId: DeviceId) => OutputId.make(`device:${deviceId}`);

/** The view shows the room of this device */
export const isOwnRoom = (view: SessionView) =>
  view.deviceId !== null && view.room === deviceOutputId(view.deviceId);

export const currentEntryOf = (view: SessionView) =>
  view.entries.find((entry) => entry.id === view.playback.entryId);

/** The position of the current entry at the local time `now` */
export const positionOf = (view: SessionView, now: number) => {
  const position = Math.max(0, positionAt(view.playback, now + view.clockOffset));
  const durationMs = currentEntryOf(view)?.source.durationMs ?? null;
  return durationMs === null ? position : Math.min(position, durationMs);
};

/** The view shows these at once, before the server confirms them */
export const isTransportCommand = SessionCommand.isAnyOf([
  "Pause",
  "Resume",
  "Seek",
  "Skip",
  "SetVolume",
]);

// The playback fields that the server sets for a transport command, as `sessions.ts` does.
// `undefined` when the command changes nothing.
const optimisticFields = (view: SessionView, command: Command, now: number) => {
  const playback = view.playback;
  const position = positionAt(playback, now);
  const online = (id: OutputId | null) => view.outputs.some((output) => output.id === id);

  return SessionCommand.matchOrElse<Partial<Playback> | undefined>(
    command,
    {
      Pause: () =>
        playback.state === "playing"
          ? { state: "paused", positionMs: position, at: now, rate: 0 }
          : undefined,

      Resume: () => {
        if (playback.state === "playing") return undefined;

        const outputId = view.room;
        const entry =
          currentEntryOf(view) ?? nextEntry(view.entries, null, playback.repeat, "skip");
        if (outputId === null || entry === undefined) return undefined;

        const continues = playback.state === "paused" && entry.id === playback.entryId;
        return {
          state: "playing",
          entryId: entry.id,
          positionMs: continues ? position : 0,
          at: now,
          rate: 0,
          outputId,
          lost: !online(outputId),
        };
      },

      Seek: (seek) =>
        seek.entryId === playback.entryId
          ? { positionMs: seek.positionMs, at: now, rate: 0 }
          : undefined,

      Skip: (skip) => {
        if (skip.fromEntryId !== playback.entryId) return undefined;

        const target = nextEntry(
          view.entries,
          playback.entryId,
          playback.repeat,
          "skip",
          skip.direction,
        );
        if (target === undefined && skip.direction === 1) {
          return { state: "stopped", entryId: null, positionMs: 0, at: now, rate: 0 };
        }
        return { entryId: target?.id ?? playback.entryId, positionMs: 0, at: now, rate: 0 };
      },
    },
    () => undefined,
  );
};

// A transport command that the server did not confirm. `revision` is known after the reply.
class Pending extends Data.Class<{
  readonly requestId: string;
  readonly fields: Partial<Playback>;
  readonly revision: number | null;
}> {}

// The entry and the transport that the session shows while the output loads
const isLoading = (view: SessionView) =>
  view.playback.state === "playing" && view.playback.rate === 0;

const nowPlayingOf = (view: SessionView, now: number) => {
  const entry = currentEntryOf(view);
  if (view.playback.state === "stopped" || entry === undefined) return null;

  return new NowPlaying({
    source: entry.source,
    state: view.playback.state,
    positionMs: positionOf(view, now),
    at: now,
    durationMs: entry.source.durationMs,
  });
};

// Small differences of the start time come from reports and must not publish again
const sameNowPlaying = (left: NowPlaying | null, right: NowPlaying | null) => {
  if (left === null || right === null) return left === right;
  const leftStart = left.at - left.positionMs;
  const rightStart = right.at - right.positionMs;
  return (
    left.source.id === right.source.id &&
    left.state === right.state &&
    (left.state === "paused" || Math.abs(leftStart - rightStart) < 1500)
  );
};

// The server's state of one room, and the transport commands that it did not confirm yet
class RoomState extends Data.Class<{
  readonly name: string;
  readonly queueVersion: number;
  readonly entries: ReadonlyArray<QueueEntry>;
  readonly confirmed: Playback;
  readonly pending: ReadonlyArray<Pending>;
}> {}

// Each pending command adds one revision, until the server reaches it
const withPending = (room: RoomState) =>
  new Playback({
    ...room.confirmed,
    ...Object.assign({}, ...room.pending.map((pending) => pending.fields)),
    revision: room.confirmed.revision + room.pending.length,
  });

const makeSessionClient = Effect.fn(function* (options: {
  /** `null` for a client that only controls */
  readonly player: {
    readonly capabilities: PlaybackCapabilities;
    readonly volume: Effect.Effect<number>;
    /** What the device plays now, sent when it connects again */
    readonly resume: Effect.Effect<PlayerResume | null>;
  } | null;
}) {
  const connection = yield* ServerConnection;
  const crypto = yield* Crypto.Crypto;
  const view = yield* SubscriptionRef.make(initialView);
  const own = yield* SubscriptionRef.make(initialView);
  // Commands reach the server in the order of the user's keys
  const sending = yield* Semaphore.make(1);
  const state = {
    // Counts the connections, so that a retry stops when a new connection replaces the old one
    epoch: 0,
    connected: false,
    deviceId: Option.none<DeviceId>(),
    generation: 0,
    superseded: false,
    outputs: new Array<Output>(),
    clockOffset: 0,
    rooms: new Map<OutputId, RoomState>(),
    // The room that the owner chose, or the first choice after all snapshots came
    selected: Option.none<OutputId>(),
    // The rooms of `Connected` whose snapshot did not come yet
    awaiting: new Set<OutputId>(),
    // What this device plays in its own room while it is offline
    local: Option.none<Playback>(),
  };

  const ownRoom = () => Option.getOrNull(Option.map(state.deviceId, deviceOutputId));

  // A device that plays starts on its own room, a controller on the room that plays
  const selectedRoom = () => {
    if (Option.isSome(state.selected) && state.rooms.has(state.selected.value)) {
      return state.selected.value;
    }
    const mine = ownRoom();
    if (options.player !== null && mine !== null && state.rooms.has(mine)) return mine;
    const playing = [...state.rooms].find(([, room]) => room.confirmed.state === "playing");
    return playing?.[0] ?? state.rooms.keys().next().value ?? null;
  };

  const viewOf = (id: OutputId | null) => {
    const room = id === null ? undefined : state.rooms.get(id);
    const local = id !== null && id === ownRoom() ? state.local : Option.none<Playback>();
    const confirmed = room?.confirmed ?? stoppedPlayback;
    return new SessionView({
      connected: state.connected,
      deviceId: Option.getOrNull(state.deviceId),
      generation: state.generation,
      superseded: state.superseded,
      room: room === undefined ? null : id,
      name: room?.name ?? "",
      rooms: [...state.rooms].map(
        ([roomId, summary]) =>
          new RoomSummary({
            id: roomId,
            name: state.outputs.find((output) => output.id === roomId)?.name ?? summary.name,
            playback: summary.confirmed,
            current:
              summary.entries.find((entry) => entry.id === summary.confirmed.entryId)?.source ??
              null,
          }),
      ),
      queueVersion: room?.queueVersion ?? 0,
      entries: room?.entries ?? [],
      playback: Option.getOrElse(local, () =>
        room === undefined ? stoppedPlayback : withPending(room),
      ),
      confirmed,
      outputs: state.outputs,
      clockOffset: state.clockOffset,
    });
  };

  const publish = Effect.suspend(() => {
    const selected = selectedRoom();
    if (Option.isNone(state.selected) && state.awaiting.size === 0 && selected !== null) {
      state.selected = Option.some(selected);
    }
    return Effect.all([
      SubscriptionRef.set(view, viewOf(selected)),
      SubscriptionRef.set(own, viewOf(ownRoom())),
    ]);
  });

  const changeRoom = (id: OutputId, change: (room: RoomState) => Partial<RoomState>) => {
    const room = state.rooms.get(id);
    if (room === undefined) return;
    const next = new RoomState({ ...room, ...change(room) });
    state.rooms.set(
      id,
      new RoomState({
        ...next,
        pending: next.pending.filter(
          (pending) => pending.revision === null || pending.revision > next.confirmed.revision,
        ),
      }),
    );
  };

  const deviceIdOf = Effect.gen(function* () {
    if (Option.isSome(state.deviceId)) return state.deviceId.value;

    const devices = yield* connection.listDevices();
    return devices.find((device) => device.current)?.id ?? null;
  });

  const follow = Effect.gen(function* () {
    const deviceId = yield* deviceIdOf;
    // After a newer connection took over, this client stays a controller
    const player = state.superseded ? null : options.player;
    const payload = {
      player:
        player === null
          ? null
          : { capabilities: player.capabilities, volume: yield* player.volume },
      resume: player === null ? null : yield* player.resume,
    };

    yield* connection.connectDevice(payload).pipe(
      Stream.runForEach((event) =>
        Effect.flatMap(Clock.currentTimeMillis, (receivedAt) =>
          SessionEvent.match<Effect.Effect<void, MissedQueueChange>>(event, {
            Connected: (connected) =>
              Effect.sync(() => {
                state.epoch += 1;
                state.connected = true;
                state.deviceId = Option.fromNullishOr(deviceId);
                state.generation = connected.generation;
                state.outputs = [...connected.outputs];
                state.clockOffset = connected.serverTime - receivedAt;
                state.local = Option.none();
                state.awaiting = new Set(connected.rooms);
                // The rooms keep their last state until their snapshot comes
                for (const id of state.rooms.keys()) {
                  if (!connected.rooms.includes(id)) state.rooms.delete(id);
                }
                for (const id of state.rooms.keys()) changeRoom(id, () => ({ pending: [] }));
              }),

            RoomSnapshot: (snapshot) =>
              Effect.sync(() => {
                state.awaiting.delete(snapshot.room);
                state.rooms.set(
                  snapshot.room,
                  new RoomState({
                    name: snapshot.name,
                    queueVersion: snapshot.queueVersion,
                    entries: snapshot.entries,
                    confirmed: snapshot.playback,
                    pending: [],
                  }),
                );
              }),

            QueueChanged: (change) =>
              Effect.gen(function* () {
                const room = state.rooms.get(change.room);
                if (room === undefined || change.fromVersion !== room.queueVersion) {
                  return yield* new MissedQueueChange();
                }
                changeRoom(change.room, () => ({
                  queueVersion: change.version,
                  entries: applySplices(room.entries, change.splices),
                }));
              }),

            // The sample with the shortest delay gives the best offset
            PlaybackChanged: (change) =>
              Effect.sync(() => {
                changeRoom(change.room, () => ({ confirmed: change.playback }));
                state.clockOffset = Math.max(state.clockOffset, change.serverTime - receivedAt);
              }),

            RoomRemoved: ({ room }) => Effect.sync(() => state.rooms.delete(room)),

            OutputsChanged: (change) => Effect.sync(() => (state.outputs = [...change.outputs])),

            Superseded: () => Effect.sync(() => (state.superseded = true)),
          }).pipe(Effect.andThen(publish)),
        ),
      ),
    );
  }).pipe(
    Effect.catchCause((cause) => Effect.logDebug("The session stream ended", cause)),
    Effect.andThen(
      Effect.suspend(() => {
        state.connected = false;
        return publish;
      }),
    ),
  );

  yield* Effect.forkScoped(Effect.repeat(follow, Schedule.spaced("1 second")));

  /**
   * Sends a command to `target`, by default the selected room. A transport command shows in the
   * view at once. A retry sends the same request ID, so that the server applies the command once.
   */
  const send = Effect.fn(function* (command: Command, target?: OutputId) {
    const current = target === undefined ? yield* SubscriptionRef.get(view) : viewOf(target);
    const room = current.room;
    if (!current.connected || room === null) return yield* new SessionOffline();

    const requestId = yield* crypto.randomUUIDv4();
    const epoch = state.epoch;
    const now = (yield* Clock.currentTimeMillis) + current.clockOffset;

    if (SessionCommand.guards.SetVolume(command)) {
      state.outputs = state.outputs.map((output) =>
        output.id === command.outputId
          ? new Output({ ...output, volume: command.volume, muted: false })
          : output,
      );
    }
    const fields = optimisticFields(current, command, now);
    if (fields !== undefined) {
      changeRoom(room, (latest) => ({
        pending: [...latest.pending, new Pending({ requestId, fields, revision: null })],
      }));
    }
    yield* publish;

    const forget = Effect.suspend(() => {
      changeRoom(room, (latest) => ({
        pending: latest.pending.filter((pending) => pending.requestId !== requestId),
      }));
      return publish;
    });

    const request = Effect.gen(function* () {
      if (state.epoch !== epoch) return yield* new SessionOffline();
      return yield* connection.controlSession({ room, requestId, command, ifQueueVersion: null });
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("500 millis"),
        while: (error) =>
          Predicate.isTagged(error, "RpcClientError") && state.epoch === epoch && state.connected,
      }),
    );

    return yield* sending
      .withPermits(1)(request)
      .pipe(
        Effect.tap((result) =>
          Effect.suspend(() => {
            changeRoom(room, (latest) => ({
              pending: latest.pending.map((pending) =>
                pending.requestId === requestId
                  ? new Pending({ ...pending, revision: result.revision })
                  : pending,
              ),
            }));
            // The owner follows the queue into the other room
            if (SessionCommand.guards.Transfer(command)) state.selected = Option.some(command.room);
            return publish;
          }),
        ),
        Effect.tapErrorTag("SessionCommandFailed", () => forget),
        Effect.catchTag("RpcClientError", () => Effect.fail(new SessionOffline())),
      );
  });

  /** Shows and controls another room */
  const selectRoom = (id: OutputId) =>
    Effect.suspend(() => {
      state.selected = Option.some(id);
      return publish;
    });

  const nowPlaying = SubscriptionRef.changes(view).pipe(
    // While the output loads, plugins keep the previous source, so that a skip is one change
    Stream.filter((current) => !isLoading(current)),
    Stream.mapEffect((current) =>
      Effect.map(Clock.currentTimeMillis, (now) => nowPlayingOf(current, now)),
    ),
    Stream.changesWith(sameNowPlaying),
  );

  /** While offline, the own room shows what this device plays. The next snapshot replaces it. */
  const showLocal = (local: { readonly playback: Playback; readonly volume: number }) =>
    Effect.suspend(() => {
      if (state.connected) return Effect.void;
      state.local = Option.some(local.playback);
      const mine = ownRoom();
      state.outputs = state.outputs.map((output) =>
        output.id === mine ? new Output({ ...output, volume: local.volume }) : output,
      );
      return publish;
    });

  return {
    /** The room that the owner chose */
    view,
    /** The room of this device, which its engine plays */
    own,
    send,
    selectRoom,
    nowPlaying,
    showLocal,
  };
});

/**
 * Follows the rooms of the server. It subscribes again after the connection drops, and keeps the
 * last state while it is offline.
 */
export class SessionClient extends Context.Service<
  SessionClient,
  Effect.Success<ReturnType<typeof makeSessionClient>>
>()("@dyad/client-runtime/SessionClient") {}

export const sessionClientLayer = (options: Parameters<typeof makeSessionClient>[0]) =>
  Layer.effect(SessionClient, makeSessionClient(options));
