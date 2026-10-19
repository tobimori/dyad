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
  EntryCopy,
  PlaybackCapabilities,
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
  /** `local` while the replica of this device runs its room without the home server */
  readonly replica: "home" | "local";
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
  /** The copies that the room plays instead of the entries' sources */
  readonly copies: ReadonlyArray<EntryCopy>;
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
  replica: "home",
  connected: false,
  deviceId: null,
  generation: 0,
  superseded: false,
  room: null,
  name: "",
  rooms: [],
  queueVersion: 0,
  entries: [],
  copies: [],
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
  readonly nextEntryId: number;
  readonly entries: ReadonlyArray<QueueEntry>;
  readonly confirmed: Playback;
  readonly pending: ReadonlyArray<Pending>;
  readonly copies: ReadonlyArray<EntryCopy>;
}> {}

// Each pending command adds one revision, until the server reaches it
const withPending = (room: RoomState) =>
  new Playback({
    ...room.confirmed,
    ...Object.assign({}, ...room.pending.map((pending) => pending.fields)),
    revision: room.confirmed.revision + room.pending.length,
  });

// What the client knows of the rooms of one replica
const makeReplicaState = (connection: typeof ServerConnection.Service) => ({
  connection,
  // Counts the connections, so that a retry stops when a new connection replaces the old one
  epoch: 0,
  connected: false,
  deviceId: Option.none<DeviceId>(),
  generation: 0,
  superseded: false,
  outputs: new Array<Output>(),
  clockOffset: 0,
  rooms: new Map<OutputId, RoomState>(),
  // The rooms of `Connected` whose snapshot did not come yet
  awaiting: new Set<OutputId>(),
});

const ownRoomOf = (replica: ReturnType<typeof makeReplicaState>) =>
  Option.getOrNull(Option.map(replica.deviceId, deviceOutputId));

const changeRoom = (
  replica: ReturnType<typeof makeReplicaState>,
  id: OutputId,
  change: (room: RoomState) => Partial<RoomState>,
) => {
  const room = replica.rooms.get(id);
  if (room === undefined) return;
  const next = new RoomState({ ...room, ...change(room) });
  replica.rooms.set(
    id,
    new RoomState({
      ...next,
      pending: next.pending.filter(
        (pending) => pending.revision === null || pending.revision > next.confirmed.revision,
      ),
    }),
  );
};

const makeSessionClient = Effect.fn(function* (options: {
  /** `null` for a client that only controls */
  readonly player: {
    readonly capabilities: PlaybackCapabilities;
    readonly volume: Effect.Effect<number>;
  } | null;
  /**
   * The replica of this device, which runs its room while the home server is offline. Only for a
   * client with a `player`.
   */
  readonly local: typeof ServerConnection.Service | null;
}) {
  const crypto = yield* Crypto.Crypto;
  const scope = yield* Effect.scope;
  const view = yield* SubscriptionRef.make(initialView);
  const own = yield* SubscriptionRef.make(initialView);
  // Commands reach the server in the order of the user's keys
  const sending = yield* Semaphore.make(1);
  const home = makeReplicaState(yield* ServerConnection);
  const local = options.local === null ? null : makeReplicaState(options.local);
  const state = {
    // The room that the owner chose, or the first choice after all snapshots came
    selected: Option.none<OutputId>(),
    // The local replica plays the room of this device until the home server takes it back
    offline: false,
    // The home room when the local replica took it over
    handedOver: Option.none<{ readonly revision: number; readonly queueVersion: number }>(),
    // Each set of snapshots can start a hand-back, but only one runs
    handingBack: false,
    // The view changes replica when the room there has the revision of `Receive`. Before, the
    // engine sees a room without the queue.
    switching: Option.none<{ readonly offline: boolean; readonly revision: number }>(),
  };

  // A device that plays starts on its own room, a controller on the room that plays
  const selectedRoom = () => {
    if (Option.isSome(state.selected) && home.rooms.has(state.selected.value)) {
      return state.selected.value;
    }
    const mine = ownRoomOf(home);
    if (options.player !== null && mine !== null && home.rooms.has(mine)) return mine;
    const playing = [...home.rooms].find(([, room]) => room.confirmed.state === "playing");
    return playing?.[0] ?? home.rooms.keys().next().value ?? null;
  };

  const viewOf = (replica: ReturnType<typeof makeReplicaState>, id: OutputId | null) => {
    const room = id === null ? undefined : replica.rooms.get(id);
    return new SessionView({
      replica: replica === home ? "home" : "local",
      connected: replica.connected,
      deviceId: Option.getOrNull(replica.deviceId),
      generation: replica.generation,
      superseded: replica.superseded,
      room: room === undefined ? null : id,
      name: room?.name ?? "",
      rooms: [...replica.rooms].map(
        ([roomId, summary]) =>
          new RoomSummary({
            id: roomId,
            name: replica.outputs.find((output) => output.id === roomId)?.name ?? summary.name,
            playback: summary.confirmed,
            current:
              summary.entries.find((entry) => entry.id === summary.confirmed.entryId)?.source ??
              null,
          }),
      ),
      queueVersion: room?.queueVersion ?? 0,
      entries: room?.entries ?? [],
      copies: room?.copies ?? [],
      playback: room === undefined ? stoppedPlayback : withPending(room),
      confirmed: room?.confirmed ?? stoppedPlayback,
      outputs: replica.outputs,
      clockOffset: replica.clockOffset,
    });
  };

  const publish = Effect.suspend(() => {
    if (state.offline && local !== null) {
      const offlineView = viewOf(local, ownRoomOf(local));
      return Effect.all([
        SubscriptionRef.set(view, offlineView),
        SubscriptionRef.set(own, offlineView),
      ]);
    }
    const selected = selectedRoom();
    if (Option.isNone(state.selected) && home.awaiting.size === 0 && selected !== null) {
      state.selected = Option.some(selected);
    }
    return Effect.all([
      SubscriptionRef.set(view, viewOf(home, selected)),
      SubscriptionRef.set(own, viewOf(home, ownRoomOf(home))),
    ]);
  });

  const deviceIdOf = Effect.fn(function* (replica: ReturnType<typeof makeReplicaState>) {
    if (Option.isSome(replica.deviceId)) return replica.deviceId.value;
    const devices = yield* replica.connection.listDevices();
    return devices.find((device) => device.current)?.id ?? null;
  });

  const control = (
    replica: ReturnType<typeof makeReplicaState>,
    room: OutputId,
    requestId: string,
    command: Command,
    ifQueueVersion: number | null,
  ) => replica.connection.controlSession({ room, requestId, command, ifQueueVersion });

  // The queue and the transport of a room, with the position now, for `Receive`
  const receiveOf = Effect.fn(function* (
    replica: ReturnType<typeof makeReplicaState>,
    room: RoomState,
    ifRevision: number | null,
  ) {
    const now = (yield* Clock.currentTimeMillis) + replica.clockOffset;
    return SessionCommand.cases.Receive.make({
      entries: room.entries,
      playback: new Playback({ ...room.confirmed, positionMs: positionAt(room.confirmed, now) }),
      nextEntryId: room.nextEntryId,
      ifRevision,
    });
  });

  const switchTo = (offline: boolean, revision: number) =>
    Effect.suspend(() => {
      state.switching = Option.some({ offline, revision });
      return settleSwitch;
    });

  const settleSwitch = Effect.suspend(() => {
    if (Option.isNone(state.switching) || local === null) return Effect.void;
    const { offline, revision } = state.switching.value;
    const replica = offline ? local : home;
    const id = ownRoomOf(replica);
    const room = id === null ? undefined : replica.rooms.get(id);
    if (room === undefined || room.confirmed.revision < revision) return Effect.void;
    state.switching = Option.none();
    state.offline = offline;
    // The local room stops, so that it does not play on or start a radio
    const source = ownRoomOf(local);
    const stale = source === null ? undefined : local.rooms.get(source);
    const clear =
      offline || source === null || stale === undefined || stale.entries.length === 0
        ? Effect.void
        : Effect.flatMap(crypto.randomUUIDv4(), (requestId) =>
            control(
              local,
              source,
              requestId,
              SessionCommand.cases.Clear.make({ keepCurrent: false }),
              null,
            ),
          ).pipe(Effect.catchCause((cause) => Effect.logWarning("Cannot clear the room", cause)));
    return Effect.andThen(publish, Effect.forkIn(clear, scope));
  });

  // The home server went away while its room of this device had a queue
  const handOff = Effect.gen(function* () {
    if (local === null || !local.connected || state.offline || Option.isSome(state.switching)) {
      return;
    }
    const mine = ownRoomOf(home);
    const target = ownRoomOf(local);
    const room = mine === null ? undefined : home.rooms.get(mine);
    if (target === null) return;

    if (room !== undefined && room.entries.length > 0 && room.confirmed.outputId === mine) {
      const command = yield* receiveOf(home, room, null);
      const requestId = yield* crypto.randomUUIDv4();
      const result = yield* control(local, target, requestId, command, null);
      state.handedOver = Option.some({
        revision: room.confirmed.revision,
        queueVersion: room.queueVersion,
      });
      return yield* switchTo(true, result.revision);
    }
    state.offline = true;
    yield* publish;
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Cannot play without the server", cause)));

  // The home server is back, or the app quit while offline. The home room of this device
  // continues from the local room, unless somebody changed it in the meantime.
  const handBack = Effect.gen(function* () {
    if (local === null || state.handingBack || Option.isSome(state.switching)) return;
    state.handingBack = true;
    const mine = ownRoomOf(home);
    const source = ownRoomOf(local);
    const room = source === null ? undefined : local.rooms.get(source);
    const target = mine === null ? undefined : home.rooms.get(mine);
    const handedOver = state.handedOver;
    state.handedOver = Option.none();

    const used =
      room !== undefined && room.entries.length > 0 && room.confirmed.state !== "stopped";
    // A local room from a start without the server never replaces a room that plays
    const takes = Option.isSome(handedOver) || (used && target?.confirmed.state !== "playing");
    const received =
      mine !== null && room !== undefined && takes
        ? yield* control(
            home,
            mine,
            yield* crypto.randomUUIDv4(),
            yield* receiveOf(
              local,
              room,
              Option.getOrNull(Option.map(handedOver, (known) => known.revision)),
            ),
            Option.getOrNull(Option.map(handedOver, (known) => known.queueVersion)),
          ).pipe(
            Effect.map((result) => result.revision),
            Effect.catchTag("SessionCommandFailed", () => Effect.succeed(0)),
          )
        : 0;
    yield* switchTo(false, received);
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Cannot give the room back", cause)),
    Effect.ensuring(Effect.sync(() => (state.handingBack = false))),
  );

  const follow = Effect.fn(
    function* (replica: ReturnType<typeof makeReplicaState>) {
      const deviceId = yield* deviceIdOf(replica);
      // After a newer connection took over, this client stays a controller
      const player = replica.superseded ? null : options.player;
      const payload = {
        player:
          player === null
            ? null
            : { capabilities: player.capabilities, volume: yield* player.volume },
      };

      yield* replica.connection.connectDevice(payload).pipe(
        Stream.runForEach((event) =>
          Effect.flatMap(Clock.currentTimeMillis, (receivedAt) =>
            SessionEvent.match<Effect.Effect<void, MissedQueueChange>>(event, {
              Connected: (connected) =>
                Effect.sync(() => {
                  replica.epoch += 1;
                  replica.connected = true;
                  replica.deviceId = Option.fromNullishOr(deviceId);
                  replica.generation = connected.generation;
                  replica.outputs = [...connected.outputs];
                  replica.clockOffset = connected.serverTime - receivedAt;
                  replica.awaiting = new Set(connected.rooms);
                  // The rooms keep their last state until their snapshot comes
                  for (const id of replica.rooms.keys()) {
                    if (!connected.rooms.includes(id)) replica.rooms.delete(id);
                  }
                  for (const id of replica.rooms.keys()) {
                    changeRoom(replica, id, () => ({ pending: [] }));
                  }
                }),

              RoomSnapshot: (snapshot) =>
                Effect.gen(function* () {
                  replica.awaiting.delete(snapshot.room);
                  replica.rooms.set(
                    snapshot.room,
                    new RoomState({
                      name: snapshot.name,
                      queueVersion: snapshot.queueVersion,
                      nextEntryId: snapshot.nextEntryId,
                      entries: snapshot.entries,
                      confirmed: snapshot.playback,
                      pending: [],
                      copies: snapshot.copies,
                    }),
                  );
                  const complete = (known: typeof home | null) =>
                    known === null || (known.connected && known.awaiting.size === 0);
                  if (complete(home) && complete(local)) yield* Effect.forkIn(handBack, scope);
                }),

              QueueChanged: (change) =>
                Effect.gen(function* () {
                  const room = replica.rooms.get(change.room);
                  if (room === undefined || change.fromVersion !== room.queueVersion) {
                    return yield* new MissedQueueChange();
                  }
                  const entries = applySplices(room.entries, change.splices);
                  changeRoom(replica, change.room, () => ({
                    queueVersion: change.version,
                    entries,
                    nextEntryId: Math.max(
                      room.nextEntryId,
                      ...change.splices.flatMap((splice) =>
                        splice.insert.map((entry) => entry.id + 1),
                      ),
                    ),
                  }));
                }),

              // The sample with the shortest delay gives the best offset
              PlaybackChanged: (change) =>
                Effect.sync(() => {
                  changeRoom(replica, change.room, () => ({ confirmed: change.playback }));
                  replica.clockOffset = Math.max(
                    replica.clockOffset,
                    change.serverTime - receivedAt,
                  );
                }),

              CopiesChanged: ({ room, copies }) =>
                Effect.sync(() => changeRoom(replica, room, () => ({ copies }))),

              RoomRemoved: ({ room }) => Effect.sync(() => replica.rooms.delete(room)),

              OutputsChanged: (change) =>
                Effect.sync(() => (replica.outputs = [...change.outputs])),

              Superseded: () => Effect.sync(() => (replica.superseded = true)),
            }).pipe(Effect.andThen(publish), Effect.andThen(settleSwitch)),
          ),
        ),
      );
    },
    Effect.catchCause((cause) => Effect.logDebug("The session stream ended", cause)),
    (effect, replica) =>
      effect.pipe(
        Effect.andThen(
          Effect.suspend(() => {
            replica.connected = false;
            return replica === home ? Effect.andThen(publish, handOff) : publish;
          }),
        ),
      ),
  );

  for (const replica of local === null ? [home] : [home, local]) {
    yield* Effect.forkScoped(Effect.repeat(follow(replica), Schedule.spaced("1 second")));
  }

  /**
   * Sends a command to `target`, by default the room of the view. A transport command shows in
   * the view at once. A retry sends the same request ID, so that the server applies the command
   * once.
   */
  const send = Effect.fn(function* (command: Command, target?: OutputId) {
    const replica = state.offline && local !== null ? local : home;
    const current =
      target === undefined
        ? yield* SubscriptionRef.get(state.offline ? own : view)
        : viewOf(replica, target);
    const room = current.room;
    if (!current.connected || room === null) return yield* new SessionOffline();

    const requestId = yield* crypto.randomUUIDv4();
    const epoch = replica.epoch;
    const now = (yield* Clock.currentTimeMillis) + current.clockOffset;

    if (SessionCommand.guards.SetVolume(command)) {
      replica.outputs = replica.outputs.map((output) =>
        output.id === command.outputId
          ? new Output({ ...output, volume: command.volume, muted: false })
          : output,
      );
    }
    const fields = optimisticFields(current, command, now);
    if (fields !== undefined) {
      changeRoom(replica, room, (latest) => ({
        pending: [...latest.pending, new Pending({ requestId, fields, revision: null })],
      }));
    }
    yield* publish;

    const forget = Effect.suspend(() => {
      changeRoom(replica, room, (latest) => ({
        pending: latest.pending.filter((pending) => pending.requestId !== requestId),
      }));
      return publish;
    });

    const request = Effect.gen(function* () {
      if (replica.epoch !== epoch) return yield* new SessionOffline();
      return yield* control(replica, room, requestId, command, null);
    }).pipe(
      Effect.retry({
        schedule: Schedule.spaced("500 millis"),
        while: (error) =>
          Predicate.isTagged(error, "RpcClientError") &&
          replica.epoch === epoch &&
          replica.connected,
      }),
    );

    return yield* sending
      .withPermits(1)(request)
      .pipe(
        Effect.tap((result) =>
          Effect.suspend(() => {
            changeRoom(replica, room, (latest) => ({
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

  /** From the device that plays `own`, to the replica of that room */
  const report = (
    from: SessionView,
    fields: Omit<Parameters<typeof home.connection.reportPlayback>[0], "generation">,
  ) => {
    const replica = from.replica === "local" && local !== null ? local : home;
    return replica.connection.reportPlayback({ ...fields, generation: from.generation });
  };

  const nowPlaying = SubscriptionRef.changes(view).pipe(
    // While the output loads, plugins keep the previous source, so that a skip is one change
    Stream.filter((current) => !isLoading(current)),
    Stream.mapEffect((current) =>
      Effect.map(Clock.currentTimeMillis, (now) => nowPlayingOf(current, now)),
    ),
    Stream.changesWith(sameNowPlaying),
  );

  return {
    /** The room that the owner chose, or the local room of this device while offline */
    view,
    /** The room of this device, which its engine plays */
    own,
    send,
    selectRoom,
    report,
    nowPlaying,
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
