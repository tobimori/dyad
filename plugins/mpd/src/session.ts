import {
  applySplices,
  Output,
  Playback,
  SessionCommand,
  SessionCommandFailed,
  SessionEvent,
} from "@dyad/domain";
import type { OutputId, QueueEntry } from "@dyad/domain";
import {
  Clock,
  Context,
  Data,
  Deferred,
  Effect,
  Predicate,
  Schedule,
  Stream,
  SubscriptionRef,
} from "effect";

import type { SessionMirror } from "./mirror.ts";

/** The copy of the room that one MPD connection controls: the room that started to play last */
export class View extends Data.Class<{
  /** `null` while the server has no room */
  readonly room: OutputId | null;
  readonly queueVersion: number;
  readonly entries: ReadonlyArray<QueueEntry>;
  /** The queue version of the last change at each position, for `plchanges` */
  readonly changedAt: ReadonlyArray<number>;
  readonly playback: Playback;
  readonly outputs: ReadonlyArray<Output>;
  /** Server time minus local time */
  readonly clockOffset: number;
}> {}

export class Session extends Context.Service<
  Session,
  {
    readonly mirror: SessionMirror["Service"];
    readonly view: SubscriptionRef.SubscriptionRef<View>;
    /** The MPD `idle` subsystems that changed since the last `idle` answer */
    readonly changed: SubscriptionRef.SubscriptionRef<ReadonlySet<string>>;
  }
>()("@dyad/plugin-mpd/Session") {}

class MissedQueueChange extends Data.TaggedError("MissedQueueChange")<{}> {}

// What an event changes besides the rooms
class ViewChange extends Data.Class<{
  /** The room that started to play */
  readonly started: OutputId | null;
  readonly outputs: ReadonlyArray<Output> | null;
  readonly clockOffset: number | null;
}> {}

class RoomState extends Data.Class<{
  readonly queueVersion: number;
  readonly entries: ReadonlyArray<QueueEntry>;
  readonly playback: Playback;
}> {}

// A position changed when it holds another entry than before
const withQueue = (before: View, queueVersion: number, entries: ReadonlyArray<QueueEntry>) => ({
  queueVersion,
  entries,
  changedAt: entries.map((entry, index) =>
    before.entries[index]?.id === entry.id
      ? (before.changedAt[index] ?? queueVersion)
      : queueVersion,
  ),
});

const subsystemsChanged = (before: View, after: View) => {
  const [left, right] = [before.playback, after.playback];
  const volume = (view: View) =>
    view.outputs.find((output) => output.id === view.playback.outputId)?.volume;
  const outputs = (view: View) => view.outputs.map((output) => `${output.id} ${output.name}`);
  return [
    before.queueVersion !== after.queueVersion && "playlist",
    (left.state !== right.state ||
      left.entryId !== right.entryId ||
      left.revision !== right.revision ||
      left.rate !== right.rate) &&
      "player",
    (left.shuffle !== right.shuffle || left.repeat !== right.repeat) && "options",
    volume(before) !== volume(after) && "mixer",
    (left.outputId !== right.outputId ||
      left.group.join() !== right.group.join() ||
      outputs(before).join() !== outputs(after).join()) &&
      "output",
  ].filter(Predicate.isString);
};

const mark = (session: Session["Service"], subsystems: ReadonlyArray<string>) =>
  SubscriptionRef.update(session.changed, (changed) => new Set([...changed, ...subsystems]));

const updateView = (session: Session["Service"], change: (view: View) => View) =>
  SubscriptionRef.modify(session.view, (before) => {
    const after = change(before);
    return [subsystemsChanged(before, after), after];
  }).pipe(Effect.flatMap((subsystems) => mark(session, subsystems)));

const emptyPlayback = new Playback({
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

const emptyView = new View({
  room: null,
  queueVersion: 0,
  entries: [],
  changedAt: [],
  playback: emptyPlayback,
  outputs: [],
  clockOffset: 0,
});

/** Follows `mirror` for the lifetime of the scope. Completes at the first `Snapshot`. */
export const openSession = Effect.fn("openSession")(function* (mirror: SessionMirror["Service"]) {
  const session = Session.of({
    mirror,
    view: yield* SubscriptionRef.make(emptyView),
    changed: yield* SubscriptionRef.make<ReadonlySet<string>>(new Set()),
  });
  const ready = yield* Deferred.make<void>();
  const rooms = new Map<OutputId, RoomState>();

  const apply = Effect.fn(function* (event: typeof SessionEvent.Type) {
    const receivedAt = yield* Clock.currentTimeMillis;
    const before = yield* SubscriptionRef.get(session.view);
    const none = new ViewChange({ started: null, outputs: null, clockOffset: null });
    const change = yield* SessionEvent.match<Effect.Effect<ViewChange, MissedQueueChange>>(event, {
      Connected: (connected) =>
        Effect.sync(() => {
          for (const id of rooms.keys()) if (!connected.rooms.includes(id)) rooms.delete(id);
          return new ViewChange({
            started: null,
            outputs: connected.outputs,
            clockOffset: connected.serverTime - receivedAt,
          });
        }),
      RoomSnapshot: (snapshot) =>
        Effect.sync(() => {
          const { queueVersion, entries, playback } = snapshot;
          rooms.set(snapshot.room, new RoomState({ queueVersion, entries, playback }));
          return none;
        }),
      QueueChanged: (queued) =>
        Effect.gen(function* () {
          const room = rooms.get(queued.room);
          if (room === undefined || queued.fromVersion !== room.queueVersion) {
            return yield* new MissedQueueChange();
          }
          rooms.set(
            queued.room,
            new RoomState({
              ...room,
              queueVersion: queued.version,
              entries: applySplices(room.entries, queued.splices),
            }),
          );
          return none;
        }),
      PlaybackChanged: (changed) =>
        Effect.sync(() => {
          const room = rooms.get(changed.room);
          if (room === undefined) return none;
          rooms.set(changed.room, new RoomState({ ...room, playback: changed.playback }));
          const starts = changed.playback.state === "playing" && room.playback.state !== "playing";
          // The sample with the shortest delay gives the best offset
          return new ViewChange({
            started: starts ? changed.room : null,
            outputs: null,
            clockOffset: Math.max(before.clockOffset, changed.serverTime - receivedAt),
          });
        }),
      RoomRemoved: ({ room }) =>
        Effect.sync(() => {
          rooms.delete(room);
          return none;
        }),
      OutputsChanged: ({ outputs }) =>
        Effect.succeed(new ViewChange({ started: null, outputs, clockOffset: null })),
      Superseded: () => Effect.succeed(none),
    });

    yield* updateView(session, (current) => {
      const playing = [...rooms].find(([, room]) => room.playback.state === "playing")?.[0];
      const target =
        [change.started, current.room, playing, rooms.keys().next().value].find(
          (id) => id !== undefined && id !== null && rooms.has(id),
        ) ?? null;
      const room = target === null ? undefined : rooms.get(target);
      return new View({
        ...current,
        ...withQueue(current, room?.queueVersion ?? 0, room?.entries ?? []),
        room: target,
        playback: room?.playback ?? emptyPlayback,
        outputs: change.outputs ?? current.outputs,
        clockOffset: change.clockOffset ?? current.clockOffset,
      });
    });
    if (!SessionEvent.guards.Connected(event)) yield* Deferred.succeed(ready, undefined);
  });

  // Each run of `events` subscribes again and starts with `Connected`
  yield* mirror.events.pipe(
    Stream.runForEach(apply),
    Effect.ignore,
    Effect.repeat(Schedule.spaced("1 second")),
    Effect.forkScoped,
  );
  yield* Stream.runForEach(mirror.libraryChanges, (subsystem) => mark(session, [subsystem])).pipe(
    Effect.forkScoped,
  );

  yield* Deferred.await(ready);
  // The first snapshots are no change for the client
  yield* SubscriptionRef.set(session.changed, new Set());
  return session;
});

/** Completes after the view shows the change */
export const control = Effect.fn("control")(function* (
  command: typeof SessionCommand.Type,
  ifQueueVersion: number | null,
) {
  const session = yield* Session;
  const room = (yield* SubscriptionRef.get(session.view)).room;
  if (room === null) return yield* new SessionCommandFailed({ reason: "output_unavailable" });
  const result = yield* session.mirror.control(room, command, ifQueueVersion);
  yield* SubscriptionRef.changes(session.view).pipe(
    Stream.filter(
      (view) =>
        view.queueVersion >= result.queueVersion && view.playback.revision >= result.revision,
    ),
    Stream.runHead,
  );
  // These commands change no revision, so the view shows them before the event comes
  yield* updateView(session, (view) =>
    SessionCommand.matchOrElse(
      command,
      {
        SetShuffle: ({ on }) =>
          new View({ ...view, playback: new Playback({ ...view.playback, shuffle: on }) }),
        SetRepeat: ({ mode }) =>
          new View({ ...view, playback: new Playback({ ...view.playback, repeat: mode }) }),
        SetVolume: ({ outputId, volume }) =>
          new View({
            ...view,
            outputs: view.outputs.map((output) =>
              output.id === outputId ? new Output({ ...output, volume }) : output,
            ),
          }),
      },
      () => view,
    ),
  );
  return result.entryIds;
});
