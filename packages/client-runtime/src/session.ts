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
  OfflinePlay,
  PlaybackCapabilities,
  PlayerResume,
  QueueEntry,
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

/** The client's copy of the user's session */
export class SessionView extends Data.Class<{
  /** `false` while the client has no stream from the server. The view keeps the last state. */
  readonly connected: boolean;
  /** `null` before the first connection */
  readonly deviceId: DeviceId | null;
  /** Reports of this connection send it */
  readonly generation: number;
  /** A newer connection of this device plays. This client only controls. */
  readonly superseded: boolean;
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
  lost: false,
  shuffle: false,
  repeat: "off",
});

const initialView = new SessionView({
  connected: false,
  deviceId: null,
  generation: 0,
  superseded: false,
  queueVersion: 0,
  entries: [],
  playback: stoppedPlayback,
  confirmed: stoppedPlayback,
  outputs: [],
  clockOffset: 0,
});

export const deviceOutputId = (deviceId: DeviceId) => OutputId.make(`device:${deviceId}`);

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

        const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
        const outputId = online(playback.outputId) || !online(own) ? playback.outputId : own;
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

const makeSessionClient = (options: {
  /** `null` for a client that only controls */
  readonly player: {
    readonly capabilities: PlaybackCapabilities;
    readonly volume: Effect.Effect<number>;
    /** What the device plays now, sent when it connects again */
    readonly resume: Effect.Effect<PlayerResume | null>;
  } | null;
  /** The plays of offline time that the server does not have yet */
  readonly playLog: {
    readonly pending: Effect.Effect<ReadonlyArray<OfflinePlay>>;
    readonly remove: (plays: ReadonlyArray<OfflinePlay>) => Effect.Effect<void>;
  } | null;
}) =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const crypto = yield* Crypto.Crypto;
    const view = yield* SubscriptionRef.make(initialView);
    const scope = yield* Effect.scope;
    // Commands reach the server in the order of the user's keys
    const sending = yield* Semaphore.make(1);
    const sendingPlays = yield* Semaphore.make(1);
    const state = {
      // Counts the snapshots, so that a retry stops when a new connection replaces the old one
      epoch: 0,
      pending: new Array<Pending>(),
      // What this device plays while it is offline
      local: Option.none<Playback>(),
    };

    const update = (change: (current: SessionView) => Partial<SessionView>) =>
      SubscriptionRef.update(view, (current) => {
        const next = { ...current, ...change(current) };
        // Each pending command adds one revision, until the server reaches it
        state.pending = state.pending.filter(
          (pending) => pending.revision === null || pending.revision > next.confirmed.revision,
        );
        const playback = Option.getOrElse(
          state.local,
          () =>
            new Playback({
              ...next.confirmed,
              ...Object.assign({}, ...state.pending.map((pending) => pending.fields)),
              revision: next.confirmed.revision + state.pending.length,
            }),
        );
        return new SessionView({ ...next, playback });
      });

    const deviceIdOf = Effect.gen(function* () {
      const known = (yield* SubscriptionRef.get(view)).deviceId;
      if (known !== null) return known;

      const devices = yield* connection.listDevices();
      return devices.find((device) => device.current)?.id ?? null;
    });

    const follow = Effect.gen(function* () {
      const deviceId = yield* deviceIdOf;
      const superseded = (yield* SubscriptionRef.get(view)).superseded;
      // After a newer connection took over, this client stays a controller
      const player = superseded ? null : options.player;
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
              Snapshot: (snapshot) =>
                Effect.suspend(() => {
                  state.epoch += 1;
                  state.pending = [];
                  state.local = Option.none();
                  return update(() => ({
                    connected: true,
                    deviceId,
                    generation: snapshot.generation,
                    queueVersion: snapshot.queueVersion,
                    entries: snapshot.entries,
                    confirmed: snapshot.playback,
                    outputs: snapshot.outputs,
                    clockOffset: snapshot.serverTime - receivedAt,
                  })).pipe(Effect.andThen(Effect.forkIn(sendPlays, scope)));
                }),

              QueueChanged: (change) =>
                Effect.gen(function* () {
                  const current = yield* SubscriptionRef.get(view);
                  if (change.fromVersion !== current.queueVersion) {
                    return yield* new MissedQueueChange();
                  }
                  yield* update(() => ({
                    queueVersion: change.version,
                    entries: applySplices(current.entries, change.splices),
                  }));
                }),

              // The sample with the shortest delay gives the best offset
              PlaybackChanged: (change) =>
                update((current) => ({
                  confirmed: change.playback,
                  clockOffset: Math.max(current.clockOffset, change.serverTime - receivedAt),
                })),

              OutputsChanged: (change) => update(() => ({ outputs: change.outputs })),

              Superseded: () => update(() => ({ superseded: true })),
            }),
          ),
        ),
      );
    }).pipe(
      Effect.catchCause((cause) => Effect.logDebug("The session stream ended", cause)),
      Effect.andThen(update(() => ({ connected: false }))),
    );

    yield* Effect.forkScoped(Effect.repeat(follow, Schedule.spaced("1 second")));

    // A retry after a lost reply records nothing twice, because the server knows each play ID
    const sendPlays = sendingPlays.withPermits(1)(
      Effect.gen(function* () {
        if (options.playLog === null || !SubscriptionRef.getUnsafe(view).connected) return;
        const plays = yield* options.playLog.pending;
        if (plays.length === 0) return;

        yield* connection.recordPlays({ plays });
        yield* options.playLog.remove(plays);
      }).pipe(
        Effect.catchCause((cause) => Effect.logDebug("Cannot send the offline plays", cause)),
      ),
    );

    /**
     * A transport command shows in the view at once. A retry sends the same request ID, so that
     * the server applies the command once.
     */
    const send = (command: Command) =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(view);
        if (!current.connected) return yield* new SessionOffline();

        const requestId = yield* crypto.randomUUIDv4();
        const epoch = state.epoch;
        const now = (yield* Clock.currentTimeMillis) + current.clockOffset;

        if (SessionCommand.guards.SetVolume(command)) {
          yield* update((latest) => ({
            outputs: latest.outputs.map((output) =>
              output.id === command.outputId
                ? new Output({ ...output, volume: command.volume })
                : output,
            ),
          }));
        }
        const fields = optimisticFields(current, command, now);
        if (fields !== undefined) {
          state.pending.push(new Pending({ requestId, fields, revision: null }));
          yield* update(() => ({}));
        }

        const forget = Effect.suspend(() => {
          state.pending = state.pending.filter((pending) => pending.requestId !== requestId);
          return update(() => ({}));
        });

        const request = Effect.gen(function* () {
          if (state.epoch !== epoch) return yield* new SessionOffline();
          return yield* connection.controlSession({ requestId, command, ifQueueVersion: null });
        }).pipe(
          Effect.retry({
            schedule: Schedule.spaced("500 millis"),
            while: (error) =>
              Predicate.isTagged(error, "RpcClientError") &&
              state.epoch === epoch &&
              SubscriptionRef.getUnsafe(view).connected,
          }),
        );

        return yield* sending
          .withPermits(1)(request)
          .pipe(
            Effect.tap((result) =>
              Effect.suspend(() => {
                state.pending = state.pending.map((pending) =>
                  pending.requestId === requestId
                    ? new Pending({ ...pending, revision: result.revision })
                    : pending,
                );
                return update(() => ({}));
              }),
            ),
            Effect.tapErrorTag("SessionCommandFailed", () => forget),
            Effect.catchTag("RpcClientError", () => Effect.fail(new SessionOffline())),
          );
      });

    const nowPlaying = SubscriptionRef.changes(view).pipe(
      // While the output loads, plugins keep the previous source, so that a skip is one change
      Stream.filter((current) => !isLoading(current)),
      Stream.mapEffect((current) =>
        Effect.map(Clock.currentTimeMillis, (now) => nowPlayingOf(current, now)),
      ),
      Stream.changesWith(sameNowPlaying),
    );

    /** While offline, the view shows what this device plays. The next snapshot replaces it. */
    const showLocal = (local: { readonly playback: Playback; readonly volume: number }) =>
      update((current) => {
        if (current.connected) return {};
        state.local = Option.some(local.playback);
        const own = current.deviceId === null ? null : deviceOutputId(current.deviceId);
        return {
          outputs: current.outputs.map((output) =>
            output.id === own ? new Output({ ...output, volume: local.volume }) : output,
          ),
        };
      });

    return {
      view,
      send,
      nowPlaying,
      showLocal,
      /** Sends the play log while connected. A snapshot also sends it. */
      sendPlays: Effect.asVoid(Effect.forkIn(sendPlays, scope)),
    };
  });

/**
 * Follows the user's session on the server. It subscribes again after the connection drops, and
 * keeps the last state while it is offline.
 */
export class SessionClient extends Context.Service<
  SessionClient,
  Effect.Success<ReturnType<typeof makeSessionClient>>
>()("@dyad/client-runtime/SessionClient") {}

export const sessionClientLayer = (options: Parameters<typeof makeSessionClient>[0]) =>
  Layer.effect(SessionClient, makeSessionClient(options));
