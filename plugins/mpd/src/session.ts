import { applySplices, Output, Playback, SessionCommand, SessionEvent } from "@dyad/domain";
import type { QueueEntry } from "@dyad/domain";
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

/** The copy of the session that one MPD connection reads */
export class View extends Data.Class<{
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

const emptyView = new View({
  queueVersion: 0,
  entries: [],
  changedAt: [],
  playback: new Playback({
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
  }),
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

  const apply = Effect.fn(function* (event: typeof SessionEvent.Type) {
    const receivedAt = yield* Clock.currentTimeMillis;
    const before = yield* SubscriptionRef.get(session.view);
    if (SessionEvent.guards.QueueChanged(event) && event.fromVersion !== before.queueVersion) {
      return yield* new MissedQueueChange();
    }
    yield* updateView(session, (current) =>
      SessionEvent.match(event, {
        Snapshot: (snapshot) =>
          new View({
            ...withQueue(current, snapshot.queueVersion, snapshot.entries),
            playback: snapshot.playback,
            outputs: snapshot.outputs,
            clockOffset: snapshot.serverTime - receivedAt,
          }),
        QueueChanged: (change) =>
          new View({
            ...current,
            ...withQueue(current, change.version, applySplices(current.entries, change.splices)),
          }),
        // The sample with the shortest delay gives the best offset
        PlaybackChanged: (change) =>
          new View({
            ...current,
            playback: change.playback,
            clockOffset: Math.max(current.clockOffset, change.serverTime - receivedAt),
          }),
        OutputsChanged: ({ outputs }) => new View({ ...current, outputs }),
        Superseded: () => current,
      }),
    );
    yield* Deferred.succeed(ready, undefined);
  });

  // Each run of `events` subscribes again and starts with a `Snapshot`
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
  // The first `Snapshot` is no change for the client
  yield* SubscriptionRef.set(session.changed, new Set());
  return session;
});

/** Completes after the view shows the change */
export const control = Effect.fn("control")(function* (
  command: typeof SessionCommand.Type,
  ifQueueVersion: number | null,
) {
  const session = yield* Session;
  const result = yield* session.mirror.control(command, ifQueueVersion);
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
