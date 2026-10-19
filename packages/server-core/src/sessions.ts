import { device, providerItem, source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  CurrentPrincipal,
  EntryCopy,
  EntryId,
  Output,
  OutputId,
  Playback,
  QueueEntry,
  QueueSplice,
  SessionCommand,
  SessionCommandFailed,
  SessionCommandResult,
  SessionEvent,
  SourceSummary,
  applySplices,
  isSameSong,
  nextEntry,
  positionAt,
} from "@dyad/domain";
import type { DeviceId, PageTrack, PlayContext } from "@dyad/domain";
import { ProviderSource } from "@dyad/plugin";
import { and, eq, inArray } from "drizzle-orm";
import {
  Cause,
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Queue,
  Random,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";

import { insertPlay } from "./history.ts";
import { Outputs } from "./outputs.ts";
import { expectedCopy, hintPrefetch } from "./playback.ts";
import { queueCopyDiscovery } from "./source-copies.ts";
import { Receivers, deviceOutput, isDeviceOutput } from "./receivers.ts";
import { usableProviders } from "./providers.ts";
import { SessionState, deleteSession, loadSessions, saveSession } from "./session-store.ts";
import { continueRadio } from "./radio.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { TimedDesired, driveTimedOutputs } from "./timed-output.ts";
import type { TimedDriver } from "./timed-output.ts";
import { isDisliked, loadDisliked } from "./taste.ts";
import { UrlDesired, driveUrlOutput } from "./url-output.ts";
import type { OutputReport, UrlDriver } from "./url-output.ts";

const maxEntries = 10_000;
// An output that plays and sends no report for this long is lost
const lostAfterMs = 15_000;
const requestLimit = 1000;
const requestLifetimeMs = 10 * 60 * 1000;
// Timed outputs get this many entries ahead; the window moves at each entry start
const timedWindow = 8;

type Event = typeof SessionEvent.Type;
type Command = typeof SessionCommand.Type;

const emptyState = new SessionState({
  entries: [],
  nextEntryId: 1,
  queueVersion: 0,
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
});

class Connection extends Data.Class<{
  readonly deviceId: DeviceId;
  readonly events: Queue.Queue<Event, Cause.Done>;
  // The rooms whose snapshot the connection got. Their events follow it.
  readonly rooms: Set<OutputId>;
}> {}

// The connection of a device that plays when the device is the output
class Player extends Data.Class<{
  readonly generation: number;
  readonly connection: Connection;
  readonly name: string;
  readonly volume: number;
}> {}

class RememberedResult extends Data.Class<{
  readonly at: number;
  readonly exit: Exit.Exit<SessionCommandResult, SessionCommandFailed>;
}> {}

// One splice per run of neighbouring indexes, last run first, so that each index is still valid
const removalSplices = (indexes: ReadonlyArray<number>) =>
  indexes
    .reduce<Array<{ index: number; remove: number }>>((runs, index) => {
      const last = runs.at(-1);
      if (last !== undefined && last.index + last.remove === index) last.remove += 1;
      else runs.push({ index, remove: 1 });
      return runs;
    }, [])
    .toReversed()
    .map((run) => new QueueSplice({ ...run, insert: [] }));

// What `Transfer` moves from one room into another
class MovedQueue extends Data.Class<{
  readonly entries: ReadonlyArray<QueueEntry>;
  readonly entryId: EntryId | null;
  readonly positionMs: number;
  readonly playback: Playback;
}> {}

// The device players of all rooms: a device plays its own room, or joins the group of another
const makeHousehold = (urlOutputs: typeof Outputs.Service) => {
  const players = new Map<OutputId, Player>();
  return {
    players,
    connections: new Set<Connection>(),
    nextGeneration: 1,
    available: (outputId: OutputId) => players.has(outputId) || urlOutputs.has(outputId),
  };
};

// The play of the current entry since the output started it
class OpenPlay extends Data.Class<{
  readonly entry: QueueEntry;
  readonly deviceId: DeviceId;
  readonly startedAt: number;
  readonly playedMs: number;
  // `null` while the clock stands
  readonly resumedAt: number | null;
}> {}

const noCopies: ReadonlyArray<EntryCopy> = [];

const makeSession = Effect.fn(function* (
  room: OutputId,
  initial: SessionState,
  household: ReturnType<typeof makeHousehold>,
  prefetch: (sourceIds: ReadonlyArray<string>) => void,
  // The entries whose copies clients see
  wantCopies: (entries: ReadonlyArray<QueueEntry>) => void,
  queueEnds: (entries: ReadonlyArray<QueueEntry>) => void,
  // A device volume changed
  outputsChanged: () => void,
) {
  const services = yield* Effect.context<Database | Crypto.Crypto>();
  const urlOutputs = yield* Outputs;
  const receivers = yield* Receivers;
  const driverServices =
    yield* Effect.context<Effect.Services<ReturnType<typeof driveUrlOutput>>>();
  const timedServices =
    yield* Effect.context<Effect.Services<ReturnType<typeof driveTimedOutputs>>>();
  const lock = yield* Semaphore.make(1);
  // Changed only under `lock`
  const state = {
    entries: initial.entries,
    nextEntryId: initial.nextEntryId,
    queueVersion: initial.queueVersion,
    playback: initial.playback,
    // Failed starts since the last start that played. One pass over the queue at most.
    failures: 0,
    reportDeadline: 0,
    requests: new Map<string, RememberedResult>(),
    // Changed since the last save
    dirty: false,
    play: Option.none<OpenPlay>(),
    // The entry that ended by itself in this change. Its play is complete.
    ended: Option.none<EntryId>(),
    // The sources of the last prefetch hint, joined
    prefetched: "",
    copies: noCopies,
    // The entries of the last copies request, joined
    copiesFor: "",
    // Set while the output is a URL output
    urlDriver: Option.none<UrlDriver>(),
    // Set while the output is a timed output
    timedDriver: Option.none<TimedDriver>(),
    // The drivers that close now. A new driver waits for them, else the last commands of an old
    // driver can stop a device that the new one started, for example a Sonos that leaves AirPlay.
    closing: Effect.void,
    // A play on a URL output counts for the device that sent the last command
    commandDevice: Option.none<DeviceId>(),
    // The entry that asked for radio songs last, so that it asks once
    refilled: Option.none<EntryId>(),
  };

  const players = household.players;

  const broadcast = (event: Event) => {
    for (const connection of household.connections) {
      if (connection.rooms.has(room)) Queue.offerUnsafe(connection.events, event);
    }
  };

  const available = household.available;

  const timedCapable = (outputId: OutputId) =>
    players.has(outputId)
      ? receivers.has(outputId)
      : urlOutputs.has(outputId) && urlOutputs.timedCapable(outputId);

  // In a timed group, or in a group of URL outputs that the plugin groups
  const groupable = (outputId: OutputId) =>
    timedCapable(outputId) || (!players.has(outputId) && urlOutputs.joinable([outputId]));

  // A group plays through the renderer, unless its plugin groups it, for example a group of Sonos
  // only. A URL output or a device alone plays by itself.
  const timedRoute = () => {
    const { outputId, group } = state.playback;
    if (outputId === null) return false;
    const members = [outputId, ...group];
    return urlOutputs.isTimed(outputId) || (group.length > 0 && !urlOutputs.isNative(members));
  };

  const indexOf = (entryId: EntryId | null) =>
    state.entries.findIndex((entry) => entry.id === entryId);

  const currentEntry = () => state.entries[indexOf(state.playback.entryId)];

  const setPlayback = (fields: Partial<Playback>) => {
    state.playback = new Playback({ ...state.playback, ...fields });
  };

  const spliceQueue = (splices: ReadonlyArray<QueueSplice>) => {
    const fromVersion = state.queueVersion;
    state.entries = applySplices(state.entries, splices);
    state.queueVersion += 1;
    broadcast(
      SessionEvent.cases.QueueChanged.make({
        room,
        fromVersion,
        version: state.queueVersion,
        splices,
      }),
    );
  };

  const createEntries = (
    sources: ReadonlyArray<SourceSummary>,
    context: typeof PlayContext.Type,
    pinned: boolean,
    reasons: Readonly<Record<string, string>> = {},
  ) =>
    sources.map((summary) => {
      const id = EntryId.make(state.nextEntryId);
      state.nextEntryId += 1;
      const reason = reasons[summary.id] ?? null;
      return new QueueEntry({ id, source: summary, pinned, context, unplayable: false, reason });
    });

  // A new transport: the output loads the entry, so the position does not move until it reports
  const start = (entryId: EntryId, positionMs: number, now: number, outputId: OutputId | null) =>
    setPlayback({
      state: outputId === null ? "paused" : "playing",
      entryId,
      positionMs,
      at: now,
      rate: 0,
      revision: state.playback.revision + 1,
      outputId,
      group: outputId === state.playback.outputId ? state.playback.group : [],
      lost: outputId !== null && !available(outputId),
    });

  const stop = (entryId: EntryId | null, now: number) =>
    setPlayback({
      state: "stopped",
      entryId,
      positionMs: 0,
      at: now,
      rate: 0,
      revision: state.playback.revision + 1,
    });

  const playedUntil = (play: OpenPlay, now: number) =>
    play.resumedAt === null ? play.playedMs : play.playedMs + now - play.resumedAt;

  const endPlay = (play: OpenPlay, now: number, completed: boolean) => {
    state.play = Option.none();
    return insertPlay({
      deviceId: play.deviceId,
      sourceId: play.entry.source.id,
      startedAt: play.startedAt,
      playedMs: playedUntil(play, now),
      completed,
      context: play.entry.context,
    }).pipe(
      orDieOnDatabaseError("insertPlay"),
      Effect.catchCause((cause) => Effect.logError("Cannot record a play", cause)),
      Effect.provide(services),
    );
  };

  // A play ends when its entry stops being current or ends by itself. Its time counts while the
  // clock of the session runs.
  const trackPlay = Effect.fn(function* (now: number) {
    const playback = state.playback;
    const ended = state.ended;
    state.ended = Option.none();

    if (Option.isSome(state.play)) {
      const play = state.play.value;
      const playedMs = playedUntil(play, now);
      const completed = Option.contains(ended, play.entry.id);

      if (completed || playback.entryId !== play.entry.id || playback.state === "stopped") {
        yield* endPlay(play, now, completed);
      } else if (playback.rate === 0 && play.resumedAt !== null) {
        state.play = Option.some(new OpenPlay({ ...play, playedMs, resumedAt: null }));
      } else if (playback.rate === 1 && play.resumedAt === null) {
        state.play = Option.some(new OpenPlay({ ...play, resumedAt: now }));
      }
    }

    const entry = currentEntry();
    const output = playback.outputId === null ? undefined : players.get(playback.outputId);
    const deviceId =
      output?.connection.deviceId ??
      (Option.isSome(state.urlDriver) || Option.isSome(state.timedDriver)
        ? Option.getOrUndefined(state.commandDevice)
        : undefined);
    if (Option.isNone(state.play) && playback.rate === 1 && entry && deviceId) {
      state.play = Option.some(
        new OpenPlay({ entry, deviceId, startedAt: now, playedMs: 0, resumedAt: now }),
      );
    }
  });

  // The next two entries that a skip or the end of an entry can start
  const upcomingEntries = () => {
    const { entryId, repeat, state: transport } = state.playback;
    // A paused session can wait for weeks, for example after a restart
    if (transport !== "playing") return [];

    const first = nextEntry(state.entries, entryId, repeat, "skip");
    const second = first && nextEntry(state.entries, first.id, repeat, "skip");
    return [first, second].flatMap((entry) =>
      entry === undefined || entry.id === entryId ? [] : [entry],
    );
  };

  // The current entry and the entries that follow it, until one repeats
  const playOrder = () => {
    const first = currentEntry();
    if (first === undefined) return [];
    const order = [first];
    while (order.length < timedWindow) {
      const next = nextEntry(state.entries, order.at(-1)?.id ?? null, state.playback.repeat, "end");
      if (next === undefined || order.includes(next)) break;
      order.push(next);
    }
    return order;
  };

  // A session from the database opens its URL output only at its first change, so that it does
  // not take the output from another session
  const syncUrlOutput: Effect.Effect<void> = Effect.gen(function* () {
    const { outputId } = state.playback;
    if (outputId === null || timedRoute()) return;

    const { entryId, repeat } = state.playback;
    const desired = new UrlDesired({
      playback: state.playback,
      entry: currentEntry(),
      next: nextEntry(state.entries, entryId, repeat, "end"),
      entries: playOrder(),
    });
    if (Option.isSome(state.urlDriver)) return yield* state.urlDriver.value.desire(desired);
    if (!urlOutputs.has(outputId)) return;

    const created: UrlDriver = yield* driveUrlOutput({
      outputId,
      desired,
      report: (received) => reportOutput(created, received),
      taken: Effect.suspend(() => outputTaken(created)),
      memberTaken: (taken) => memberTaken(created, taken),
      after: state.closing,
    }).pipe(Effect.provideContext(driverServices));
    state.urlDriver = Option.some(created);
  });

  // Like `syncUrlOutput`. One driver serves all outputs of the group.
  const syncTimedOutput: Effect.Effect<void> = Effect.gen(function* () {
    if (!timedRoute()) return;
    const driver = Option.getOrUndefined(state.timedDriver);

    const desired = new TimedDesired({ playback: state.playback, entries: playOrder() });
    if (driver !== undefined) return yield* driver.desire(desired);

    const created: TimedDriver = yield* driveTimedOutputs({
      desired,
      report: (received) => reportTimed(created, received),
      taken: (taken) => memberTaken(created, taken),
      after: state.closing,
    }).pipe(Effect.provideContext(timedServices));
    state.timedDriver = Option.some(created);
  });

  // The drivers that do not fit the output or the route any more
  const closeStaleDrivers = Effect.gen(function* () {
    const { outputId } = state.playback;
    const timed = timedRoute();
    const url = Option.getOrUndefined(state.urlDriver);
    const renderer = Option.getOrUndefined(state.timedDriver);
    const closing = [];
    if (url !== undefined && (url.outputId !== outputId || timed)) {
      state.urlDriver = Option.none();
      closing.push(yield* url.close(true));
    }
    if (renderer !== undefined && !timed) {
      state.timedDriver = Option.none();
      closing.push(yield* renderer.close);
    }
    if (closing.length > 0) state.closing = Effect.asVoid(Fiber.awaitAll(closing));
  });

  // Runs `change` under the lock and publishes the new playback once
  const modify = <A, E>(change: (now: number) => Effect.Effect<A, E>) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const before = state.playback;
        const queueVersion = state.queueVersion;
        const exit = yield* Effect.exit(change(now));
        const changed = state.playback !== before || state.queueVersion !== queueVersion;
        if (changed) state.dirty = true;
        yield* trackPlay(now);

        const next = upcomingEntries();
        const upcoming = [...new Set(next.map((entry) => entry.source.id))];
        if (upcoming.join(" ") !== state.prefetched) {
          state.prefetched = upcoming.join(" ");
          prefetch(upcoming);
        }
        // A pinned entry plays its own copy
        const shown = [currentEntry(), ...next].flatMap((entry) =>
          entry === undefined || entry.pinned ? [] : [entry],
        );
        // Again once the entry plays, after a failed copy and after copy discovery
        const copiesFor = `${state.playback.rate} ${shown.map((entry) => `${entry.id}:${entry.source.id}`).join(" ")}`;
        if (copiesFor !== state.copiesFor) {
          state.copiesFor = copiesFor;
          wantCopies(shown);
        }
        const { entryId, repeat, autoplay } = state.playback;
        // A paused room has no upcoming sources either
        const ends =
          state.playback.state === "playing" &&
          upcoming.length === 0 &&
          repeat === "off" &&
          autoplay &&
          entryId !== null;
        if (ends && !Option.contains(state.refilled, entryId)) {
          state.refilled = Option.some(entryId);
          queueEnds(state.entries);
        }

        if (state.playback !== before) {
          // The output gets `lostAfterMs` to report after each new transport
          if (state.playback.revision !== before.revision) {
            state.reportDeadline = now + lostAfterMs;
          }
          broadcast(
            SessionEvent.cases.PlaybackChanged.make({
              room,
              serverTime: now,
              playback: state.playback,
            }),
          );
        }
        // A queue edit can change the entry that the URL output plays next
        if (changed) {
          yield* closeStaleDrivers;
          yield* syncUrlOutput;
          yield* syncTimedOutput;
        }
        return yield* exit;
      }),
    );

  const fail = (reason: SessionCommandFailed["reason"]) => new SessionCommandFailed({ reason });

  const apply = (
    command: Command,
    sources: ReadonlyMap<string, SourceSummary>,
    disliked: ReadonlySet<string>,
    now: number,
  ) => {
    const playback = state.playback;
    const position = positionAt(playback, now);

    return SessionCommand.match<Effect.Effect<ReadonlyArray<EntryId>, SessionCommandFailed>>(
      command,
      {
        Play: (command) =>
          Effect.gen(function* () {
            // A search lists one song once per source, so a source that repeats the song before it
            // does not go into the queue
            const listed = command.sourceIds.map((id) => sources.get(id));
            const kept = listed.flatMap((summary, index) => {
              if (summary === undefined) return [];
              if (index === command.index) return [{ summary, index }];
              const before = listed[index - 1];
              const repeats = before !== undefined && isSameSong(before, summary);
              return repeats || disliked.has(summary.id) ? [] : [{ summary, index }];
            });
            if (kept.length === 0) return yield* fail("nothing_to_play");
            const selected =
              command.index === null
                ? kept[yield* Random.nextIntBetween(0, kept.length, { halfOpen: true })]
                : (kept.find((item) => item.index >= (command.index ?? 0)) ?? kept.at(-1));
            if (selected === undefined) return yield* fail("nothing_to_play");

            // With shuffle, the whole list plays in random order, not only the part after `index`
            const others = kept.filter((item) => item !== selected);
            const ordered = command.shuffle ? [selected, ...(yield* Random.shuffle(others))] : kept;
            const entries = createEntries(
              ordered.map((item) => item.summary),
              command.context,
              command.pinned,
              command.reasons,
            );
            const first = entries[ordered.indexOf(selected)];
            if (first === undefined) return yield* fail("nothing_to_play");

            spliceQueue([
              new QueueSplice({ index: 0, remove: state.entries.length, insert: entries }),
            ]);
            state.failures = 0;
            setPlayback({ shuffle: command.shuffle });
            start(first.id, 0, now, room);
            return entries.map((entry) => entry.id);
          }),

        Enqueue: (command) =>
          Effect.gen(function* () {
            const summaries = command.sourceIds.flatMap((id) => sources.get(id) ?? []);
            if (summaries.length === 0) return yield* fail("nothing_to_play");
            if (state.entries.length + summaries.length > maxEntries) {
              return yield* fail("queue_full");
            }

            const target = command.after === "current" ? playback.entryId : command.after;
            const after = target === "end" ? state.entries.length - 1 : indexOf(target);
            if (after === -1 && target !== null && target !== "end") {
              return yield* fail("entry_not_found");
            }

            const entries = createEntries(summaries, command.context, command.pinned);
            spliceQueue([new QueueSplice({ index: after + 1, remove: 0, insert: entries })]);
            return entries.map((entry) => entry.id);
          }),

        Remove: (command) =>
          Effect.gen(function* () {
            const removed = new Set<EntryId>(command.entryIds);
            const indexes = state.entries.flatMap((entry, index) =>
              removed.has(entry.id) ? [index] : [],
            );
            if (indexes.length === 0) return yield* fail("entry_not_found");

            const current = playback.entryId;
            const removesCurrent = current !== null && removed.has(current);
            const following = state.entries
              .slice(indexOf(current) + 1)
              .find((entry) => !removed.has(entry.id) && !entry.unplayable);

            spliceQueue(removalSplices(indexes));
            if (!removesCurrent) return [];

            // The entry after the removed current entry continues in the same state
            if (following === undefined) stop(null, now);
            else {
              setPlayback({
                entryId: following.id,
                positionMs: 0,
                at: now,
                rate: 0,
                revision: playback.revision + 1,
              });
            }
            return [];
          }),

        Move: (command) =>
          Effect.gen(function* () {
            const moved = new Set<EntryId>(command.entryIds);
            if (command.after !== null && moved.has(command.after)) {
              return yield* fail("entry_not_found");
            }

            const indexes = state.entries.flatMap((entry, index) =>
              moved.has(entry.id) ? [index] : [],
            );
            const remaining = state.entries.filter((entry) => !moved.has(entry.id));
            const after =
              command.after === null
                ? -1
                : remaining.findIndex((entry) => entry.id === command.after);
            if (indexes.length === 0 || (command.after !== null && after === -1)) {
              return yield* fail("entry_not_found");
            }

            const entries = indexes.flatMap((index) => state.entries[index] ?? []);
            spliceQueue([
              ...removalSplices(indexes),
              new QueueSplice({ index: after + 1, remove: 0, insert: entries }),
            ]);
            return [];
          }),

        Clear: (command) =>
          Effect.sync(() => {
            const index = indexOf(playback.entryId);
            if (command.keepCurrent && index !== -1) {
              spliceQueue(
                [
                  new QueueSplice({
                    index: index + 1,
                    remove: state.entries.length - index - 1,
                    insert: [],
                  }),
                  new QueueSplice({ index: 0, remove: index, insert: [] }),
                ].filter((splice) => splice.remove > 0),
              );
              return [];
            }

            spliceQueue([new QueueSplice({ index: 0, remove: state.entries.length, insert: [] })]);
            stop(null, now);
            return [];
          }),

        JumpTo: (command) =>
          Effect.gen(function* () {
            const index = indexOf(command.entryId);
            const entry = state.entries[index];
            if (entry === undefined) return yield* fail("entry_not_found");

            // An explicit jump tries an unplayable entry again
            if (entry.unplayable) {
              spliceQueue([
                new QueueSplice({
                  index,
                  remove: 1,
                  insert: [new QueueEntry({ ...entry, unplayable: false })],
                }),
              ]);
            }
            state.failures = 0;
            start(entry.id, command.positionMs, now, room);
            return [];
          }),

        Resume: () =>
          Effect.gen(function* () {
            if (playback.state === "playing") return [];

            const entry = currentEntry() ?? nextEntry(state.entries, null, playback.repeat, "skip");
            if (entry === undefined) return yield* fail("nothing_to_play");

            const continues = playback.state === "paused" && entry.id === playback.entryId;
            start(entry.id, continues ? position : 0, now, room);
            return [];
          }),

        Pause: () =>
          Effect.sync(() => {
            if (playback.state !== "playing") return [];

            setPlayback({
              state: "paused",
              positionMs: position,
              at: now,
              rate: 0,
              revision: playback.revision + 1,
            });
            return [];
          }),

        Stop: () =>
          Effect.sync(() => {
            stop(playback.entryId, now);
            return [];
          }),

        Seek: (command) =>
          Effect.gen(function* () {
            if (command.entryId !== playback.entryId) return yield* fail("entry_not_found");

            setPlayback({
              positionMs: command.positionMs,
              at: now,
              rate: 0,
              revision: playback.revision + 1,
            });
            return [];
          }),

        Skip: (command) =>
          Effect.sync(() => {
            // Two controllers that skip at the same time skip once
            if (command.fromEntryId !== playback.entryId) return [];

            const target = nextEntry(
              state.entries,
              playback.entryId,
              playback.repeat,
              "skip",
              command.direction,
            );
            if (target === undefined && command.direction === 1) stop(null, now);
            else {
              // Back from the first entry starts it again
              setPlayback({
                entryId: target?.id ?? playback.entryId,
                positionMs: 0,
                at: now,
                rate: 0,
                revision: playback.revision + 1,
              });
            }
            return [];
          }),

        SetShuffle: (command) =>
          Effect.gen(function* () {
            if (command.on === playback.shuffle) return [];

            // Shuffle reorders the entries after the current one. Turning it off keeps the order.
            const upcoming = indexOf(playback.entryId) + 1;
            const shuffled = yield* Random.shuffle(state.entries.slice(upcoming));
            if (command.on && shuffled.length > 1) {
              spliceQueue([
                new QueueSplice({ index: upcoming, remove: shuffled.length, insert: shuffled }),
              ]);
            }
            setPlayback({ shuffle: command.on });
            return [];
          }),

        SetRepeat: (command) =>
          Effect.sync(() => {
            if (command.mode !== playback.repeat) setPlayback({ repeat: command.mode });
            return [];
          }),

        SetAutoplay: (command) =>
          Effect.sync(() => {
            if (command.on !== playback.autoplay) setPlayback({ autoplay: command.on });
            return [];
          }),

        // The drivers keep the position: a renderer changes the next join, and a Sonos changes
        // between its queue and a live stream at the current position
        SetTransitions: ({ crossfadeSeconds, djStyle }) =>
          Effect.sync(() => {
            if (crossfadeSeconds !== playback.crossfadeSeconds || djStyle !== playback.djStyle) {
              setPlayback({ crossfadeSeconds, djStyle });
            }
            return [];
          }),

        Receive: (command) =>
          Effect.gen(function* () {
            if (command.ifRevision !== null && command.ifRevision !== playback.revision) {
              return yield* fail("stale_queue");
            }
            const entries = command.entries.map(
              (entry) => new QueueEntry({ ...entry, unplayable: false }),
            );
            spliceQueue([
              new QueueSplice({ index: 0, remove: state.entries.length, insert: entries }),
            ]);
            state.nextEntryId = Math.max(
              state.nextEntryId,
              command.nextEntryId,
              ...entries.map((entry) => entry.id + 1),
            );
            state.failures = 0;
            // The sending replica records its part of the play; this part counts the lost time
            state.play = Option.none();

            const received = command.playback;
            const { shuffle, repeat, autoplay, crossfadeSeconds, djStyle } = received;
            setPlayback({ shuffle, repeat, autoplay, crossfadeSeconds, djStyle });
            const current = entries.find((entry) => entry.id === received.entryId);
            if (current === undefined || received.state === "stopped") {
              stop(current?.id ?? null, now);
            } else if (received.state === "playing") {
              start(current.id, received.positionMs, now, room);
            } else {
              setPlayback({
                state: "paused",
                entryId: current.id,
                positionMs: received.positionMs,
                at: now,
                rate: 0,
                revision: playback.revision + 1,
                outputId: room,
                lost: !available(room),
              });
            }
            return [];
          }),

        // `Sessions` moves the queue, because it needs two rooms
        Transfer: () => Effect.die(new Error("A room cannot transfer by itself")),

        // The outputs that play already keep playing, so the change needs no new transport
        SetGroup: (command) =>
          Effect.gen(function* () {
            const all = [room, ...new Set(command.members.filter((id) => id !== room))];
            if (all.length > 1 && !all.every(timedCapable) && !urlOutputs.joinable(all)) {
              return yield* fail("output_unavailable");
            }
            setPlayback({ outputId: room, group: all.slice(1) });
            return [];
          }),

        SetOutputDelay: (command) =>
          Effect.gen(function* () {
            if (!groupable(command.outputId)) return yield* fail("output_unavailable");
            // Its outputs change gives the new delay to all sessions
            yield* urlOutputs.setDelay(command.outputId, command.delayMs);
            return [];
          }),

        SetVolume: (command) =>
          Effect.gen(function* () {
            const player = players.get(command.outputId);
            if (player === undefined) {
              // Its status or its outputs change gives the new volume to all sessions
              const setting = urlOutputs.setVolume(command.outputId, command.volume);
              if (setting === undefined) return yield* fail("output_unavailable");
              yield* setting.pipe(
                Effect.catch((error) => Effect.logWarning("Cannot set the volume", error.reason)),
                Effect.forkDetach,
              );
              return [];
            }

            players.set(command.outputId, new Player({ ...player, volume: command.volume }));
            outputsChanged();
            return [];
          }),
      },
    );
  };

  const remember = (
    requestId: string,
    exit: Exit.Exit<SessionCommandResult, SessionCommandFailed>,
    now: number,
  ) => {
    for (const [id, result] of state.requests) {
      if (state.requests.size < requestLimit && result.at > now - requestLifetimeMs) break;
      state.requests.delete(id);
    }
    state.requests.set(requestId, new RememberedResult({ at: now, exit }));
  };

  const control = (
    deviceId: DeviceId,
    request: {
      readonly requestId: string;
      readonly command: Command;
      readonly ifQueueVersion: number | null;
    },
    sources: ReadonlyMap<string, SourceSummary>,
    /** The IDs of the sources that are disliked songs */
    disliked: ReadonlySet<string>,
  ) =>
    modify((now) =>
      Effect.gen(function* () {
        state.commandDevice = Option.some(deviceId);
        const remembered = state.requests.get(request.requestId);
        if (remembered !== undefined) return yield* remembered.exit;

        const exit = yield* Effect.exit(
          Effect.gen(function* () {
            if (request.ifQueueVersion !== null && request.ifQueueVersion !== state.queueVersion) {
              return yield* fail("stale_queue");
            }

            const entryIds = yield* apply(request.command, sources, disliked, now);
            return new SessionCommandResult({
              queueVersion: state.queueVersion,
              revision: state.playback.revision,
              entryIds,
            });
          }),
        );
        remember(request.requestId, exit, now);
        return yield* exit;
      }),
    );

  const report = (
    deviceId: DeviceId,
    received: {
      readonly generation: number;
      readonly revision: number;
      readonly entryId: EntryId;
      readonly state: OutputReport["state"];
      readonly positionMs: number;
      readonly volume: number;
    },
  ) =>
    modify((now) =>
      Effect.sync(() => {
        const outputId = deviceOutput(deviceId);
        const player = players.get(outputId);
        if (player?.generation !== received.generation) return;
        if (state.playback.outputId !== outputId) return;

        if (received.volume !== player.volume) {
          players.set(outputId, new Player({ ...player, volume: received.volume }));
          outputsChanged();
        }
        applyReport(outputId, received, now);
      }),
    );

  const reportOutput = (driver: UrlDriver, received: OutputReport) =>
    modify((now) =>
      Effect.sync(() => {
        const outputId = state.playback.outputId;
        if (Option.getOrUndefined(state.urlDriver) !== driver || outputId === null) return;
        applyReport(outputId, received, now);
      }),
    );

  const reportTimed = (driver: TimedDriver, received: OutputReport) =>
    modify((now) =>
      Effect.sync(() => {
        const outputId = state.playback.outputId;
        if (Option.getOrUndefined(state.timedDriver) !== driver || outputId === null) return;
        applyReport(outputId, received, now);
      }),
    );

  // Another session or controller took one output of the group. The others play on.
  const memberTaken = (driver: TimedDriver | UrlDriver, taken: OutputId) =>
    modify((now) =>
      Effect.sync(() => {
        const current =
          Option.getOrUndefined(state.timedDriver) === driver ||
          Option.getOrUndefined(state.urlDriver) === driver;
        if (current) releaseNow([taken], now);
      }),
    );

  // A report of the output that plays, from its device or from one of its drivers
  const applyReport = (
    outputId: OutputId,
    received: {
      readonly revision: number;
      readonly entryId: EntryId;
      readonly state: OutputReport["state"];
      readonly positionMs: number;
    },
    now: number,
  ) => {
    const playback = state.playback;
    state.reportDeadline = now + lostAfterMs;
    if (playback.lost) setPlayback({ lost: false });
    if (received.revision !== playback.revision) return;

    const current = playback.entryId;
    const next = nextEntry(state.entries, current, playback.repeat, "end");
    const anchor = { positionMs: received.positionMs, at: now };

    Match.value(received.state).pipe(
      Match.when("playing", () => {
        // The output started the next entry by itself
        if (received.entryId !== current && received.entryId !== next?.id) return;

        state.failures = 0;
        // Small drift keeps the anchor, so that regular reports do not publish
        const expected = positionAt(playback, now);
        const drift = Math.abs(expected - received.positionMs);
        const moving = playback.state === "playing" && playback.rate === 1;
        if (received.entryId === current && moving && drift < 1000) return;

        // Under repeat, the output can also start the same entry again by itself
        const durationMs = currentEntry()?.source.durationMs ?? null;
        const loops =
          next?.id === current &&
          moving &&
          durationMs !== null &&
          expected > durationMs - 5000 &&
          received.positionMs < 5000;
        if (received.entryId !== current || loops) {
          state.ended = Option.fromNullishOr(current);
        }
        setPlayback({ state: "playing", entryId: received.entryId, rate: 1, ...anchor });
      }),
      Match.whenOr("paused", "buffering", (reported) => {
        if (received.entryId !== current) return;
        setPlayback({
          ...anchor,
          rate: 0,
          state: reported === "paused" ? "paused" : playback.state,
        });
      }),
      Match.when("ended", () => {
        if (received.entryId !== current) return;
        state.ended = Option.some(current);
        if (next === undefined) stop(null, now);
        else setPlayback({ entryId: next.id, positionMs: 0, at: now, rate: 0 });
      }),
      Match.when("failed", () => {
        const index = indexOf(received.entryId);
        const entry = state.entries[index];
        if (entry === undefined || entry.unplayable) return;

        spliceQueue([
          new QueueSplice({
            index,
            remove: 1,
            insert: [new QueueEntry({ ...entry, unplayable: true })],
          }),
        ]);
        // A timed output loads the next entries ahead, so they can fail before they play
        if (received.entryId !== current) return;
        state.failures += 1;

        const following = nextEntry(state.entries, current, playback.repeat, "skip");
        if (following === undefined || state.failures >= state.entries.length) {
          stop(current, now);
          return;
        }
        start(following.id, 0, now, outputId);
      }),
      // The output fails, not the entry, so the entry stays playable and the session waits
      Match.when("stalled", () => {
        if (received.entryId !== current) return;
        setPlayback({
          ...anchor,
          state: "paused",
          rate: 0,
          revision: playback.revision + 1,
          lost: true,
        });
      }),
      Match.exhaustive,
    );
  };

  // The room's device connected as a player
  const playerJoined = modify(() =>
    Effect.sync(() => {
      if (state.playback.outputId === room && state.playback.lost) setPlayback({ lost: false });
    }),
  );

  // In a group, the renderer finds that the device is gone
  const playerLeft = modify(() =>
    Effect.sync(() => {
      if (state.playback.outputId === room && state.playback.group.length === 0) {
        setPlayback({ lost: true });
      }
    }),
  );

  /** Sends the room's snapshot, then its events */
  const subscribe = (connection: Connection, name: string) =>
    lock.withPermits(1)(
      Effect.sync(() => {
        Queue.offerUnsafe(
          connection.events,
          SessionEvent.cases.RoomSnapshot.make({
            room,
            name,
            queueVersion: state.queueVersion,
            nextEntryId: state.nextEntryId,
            entries: state.entries,
            playback: state.playback,
            copies: state.copies,
          }),
        );
        connection.rooms.add(room);
      }),
    );

  // The session pauses where it is and has no output
  const dropOutput = (now: number) => {
    const playback = state.playback;
    setPlayback({
      state: playback.state === "stopped" ? "stopped" : "paused",
      positionMs: positionAt(playback, now),
      at: now,
      rate: 0,
      revision: playback.revision + 1,
      outputId: null,
      group: [],
      lost: false,
    });
  };

  // Another session or another controller took the URL output
  const outputTaken = (driver: UrlDriver) =>
    modify((now) =>
      Effect.gen(function* () {
        if (Option.getOrUndefined(state.urlDriver) !== driver) return;
        state.urlDriver = Option.none();
        yield* driver.close(false);
        dropOutput(now);
      }),
    );

  // The room's own output pauses the room; a member leaves the group
  const releaseNow = (taken: ReadonlyArray<OutputId>, now: number) => {
    const { outputId, group } = state.playback;
    if (outputId !== null && taken.includes(outputId)) dropOutput(now);
    else if (group.some((id) => taken.includes(id))) {
      setPlayback({ group: group.filter((id) => !taken.includes(id)) });
    }
  };

  /** Gives up `taken` for another room. Completes after the drivers of the outputs stopped. */
  const release = (taken: ReadonlyArray<OutputId>) =>
    modify((now) => Effect.sync(() => releaseNow(taken, now))).pipe(
      Effect.andThen(Effect.suspend(() => state.closing)),
    );

  /** Empties the room and stops it, for `Transfer` */
  const takeQueue = modify((now) =>
    Effect.sync(() => {
      if (state.entries.length === 0) return Option.none<MovedQueue>();
      const moved = new MovedQueue({
        entries: state.entries,
        entryId: state.playback.entryId,
        positionMs: positionAt(state.playback, now),
        playback: state.playback,
      });
      spliceQueue([new QueueSplice({ index: 0, remove: state.entries.length, insert: [] })]);
      stop(null, now);
      return Option.some(moved);
    }),
  );

  /** Replaces the queue with the queue of another room, with new entry IDs */
  const adoptQueue = (moved: MovedQueue, play: boolean | null) =>
    modify((now) =>
      Effect.sync(() => {
        const entries = moved.entries.map((entry) => {
          const id = EntryId.make(state.nextEntryId);
          state.nextEntryId += 1;
          return new QueueEntry({ ...entry, id, unplayable: false });
        });
        const current = entries[moved.entries.findIndex((entry) => entry.id === moved.entryId)];
        spliceQueue([new QueueSplice({ index: 0, remove: state.entries.length, insert: entries })]);
        state.failures = 0;

        const { shuffle, repeat, autoplay, crossfadeSeconds, djStyle } = moved.playback;
        setPlayback({ shuffle, repeat, autoplay, crossfadeSeconds, djStyle });
        if (current === undefined || moved.playback.state === "stopped") {
          stop(current?.id ?? null, now);
        } else if (play ?? moved.playback.state === "playing") {
          start(current.id, moved.positionMs, now, room);
        } else {
          setPlayback({
            state: "paused",
            entryId: current.id,
            positionMs: moved.positionMs,
            at: now,
            rate: 0,
            revision: state.playback.revision + 1,
            outputId: room,
            lost: !available(room),
          });
        }
        return new SessionCommandResult({
          queueVersion: state.queueVersion,
          revision: state.playback.revision,
          entryIds: [],
        });
      }),
    );

  // A silent output is lost. A lost output plays on from its buffer until the end of the entry.
  const tick = modify((now) =>
    Effect.sync(() => {
      const playback = state.playback;
      // A renderer sends no reports while an entry plays: it knows the position
      const reports =
        Option.isNone(state.timedDriver) &&
        !Option.exists(state.urlDriver, (driver) => driver.rendering());
      if (playback.state === "playing" && !playback.lost && reports && now > state.reportDeadline) {
        setPlayback({ lost: true });
      }

      const durationMs = currentEntry()?.source.durationMs ?? null;
      const ended = durationMs !== null && positionAt(state.playback, now) >= durationMs;
      if (state.playback.lost && state.playback.rate === 1 && ended) {
        setPlayback({ positionMs: durationMs, at: now, rate: 0 });
      }
    }),
  );

  /** Records the open play, at shutdown */
  const endOpenPlay = lock.withPermits(1)(
    Effect.gen(function* () {
      if (Option.isNone(state.play)) return;
      yield* endPlay(state.play.value, yield* Clock.currentTimeMillis, false);
    }),
  );

  /** The state to save when it changed since the last call. With `all`, a moving position counts. */
  const changes = (all: boolean) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const moving = all && state.playback.rate === 1;
        if (!state.dirty && !moving) return Option.none<SessionState>();

        const now = yield* Clock.currentTimeMillis;
        state.dirty = false;
        const playback = state.playback;
        return Option.some(
          new SessionState({
            entries: state.entries,
            nextEntryId: state.nextEntryId,
            queueVersion: state.queueVersion,
            playback: new Playback({
              ...playback,
              positionMs: positionAt(playback, now),
              at: now,
            }),
          }),
        );
      }),
    );

  /** Adds radio songs at the end, unless the last entry is no longer `afterId` */
  const appendRadio = (afterId: EntryId, tracks: ReadonlyArray<PageTrack>) =>
    modify(() =>
      Effect.sync(() => {
        if (state.entries.at(-1)?.id !== afterId || tracks.length === 0) return;
        if (state.entries.length + tracks.length > maxEntries) return;
        const reasons = Object.fromEntries(
          tracks.flatMap((track) =>
            track.reason === null ? [] : [[track.source.id, track.reason]],
          ),
        );
        const insert = createEntries(
          tracks.map((track) => track.source),
          "radio",
          false,
          reasons,
        );
        spliceQueue([new QueueSplice({ index: state.entries.length, remove: 0, insert })]);
      }),
    );

  /** Without a queue and a driver, so that the room can go with its output */
  const idle = lock.withPermits(1)(
    Effect.sync(
      () =>
        state.entries.length === 0 &&
        Option.isNone(state.urlDriver) &&
        Option.isNone(state.timedDriver),
    ),
  );

  const setCopies = (copies: ReadonlyArray<EntryCopy>) =>
    lock.withPermits(1)(
      Effect.sync(() => {
        const key = (list: ReadonlyArray<EntryCopy>) =>
          list.map((copy) => `${copy.entryId}:${copy.source.id}`).join(" ");
        if (key(copies) === key(state.copies)) return;
        state.copies = copies;
        broadcast(SessionEvent.cases.CopiesChanged.make({ room, copies }));
      }),
    );

  return {
    subscribe,
    setCopies,
    playerJoined,
    playerLeft,
    idle,
    control,
    report,
    release,
    takeQueue,
    adoptQueue,
    tick,
    endOpenPlay,
    changes,
    appendRadio,
  };
});

type Session = Effect.Success<ReturnType<typeof makeSession>>;

const makeSessions = Effect.gen(function* () {
  const db = yield* Database;
  const urlOutputs = yield* Outputs;
  const receivers = yield* Receivers;
  const services =
    yield* Effect.context<
      Effect.Services<
        ReturnType<
          | typeof makeSession
          | typeof hintPrefetch
          | typeof continueRadio
          | typeof queueCopyDiscovery
          | typeof expectedCopy
        >
      >
    >();
  const household = makeHousehold(urlOutputs);
  const rooms = new Map<OutputId, Session>();
  // The last known name of each room's output
  const names = new Map<OutputId, string>();
  // Creating a room and connecting a device take turns, so that each connection gets each room
  const roomsLock = yield* Semaphore.make(1);

  const outputs = () => [
    ...[...household.players].map(
      ([id, player]) =>
        new Output({
          id,
          kind: "device",
          name: player.name,
          volume: player.volume,
          muted: false,
          delayMs: urlOutputs.delayOf(id),
          groupable: receivers.has(id),
        }),
    ),
    ...urlOutputs.list(),
  ];
  const available = household.available;

  const broadcastOutputs = () => {
    const event = SessionEvent.cases.OutputsChanged.make({ outputs: outputs() });
    for (const connection of household.connections) Queue.offerUnsafe(connection.events, event);
  };

  // In order, so that the last hint of a room wins
  const prefetches = yield* Queue.unbounded<{
    readonly room: OutputId;
    readonly sourceIds: ReadonlyArray<string>;
  }>();
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(prefetches), ({ room, sourceIds }) =>
        hintPrefetch(room, sourceIds).pipe(
          // The copies of the next songs, so that a fallback and "Play from…" are ready
          Effect.andThen(queueCopyDiscovery(sourceIds)),
          orDieOnDatabaseError("hintPrefetch"),
          Effect.catchCause((cause) => Effect.logError("Cannot prefetch for a room", cause)),
        ),
      ),
    ),
  );

  // The latest request of a room replaces its older one
  const copyRequests = yield* Queue.unbounded<{
    readonly room: OutputId;
    readonly entries: ReadonlyArray<QueueEntry>;
  }>();
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(copyRequests), ({ room, entries }) =>
        Effect.gen(function* () {
          const copies = yield* Effect.forEach(entries, (entry) =>
            Effect.map(expectedCopy(entry.source.id), (copy) =>
              copy === null ? [] : [new EntryCopy({ entryId: entry.id, source: copy })],
            ),
          );
          yield* rooms.get(room)?.setCopies(copies.flat()) ?? Effect.void;
        }).pipe(
          orDieOnDatabaseError("expectedCopy"),
          Effect.provide(services),
          Effect.catchCause((cause) => Effect.logError("Cannot find the copies for a room", cause)),
        ),
      ),
    ),
  );

  // Radio requests take seconds, so they run outside the room lock
  const endings = yield* Queue.unbounded<{
    readonly room: OutputId;
    readonly entries: ReadonlyArray<QueueEntry>;
  }>();
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(endings), ({ room, entries }) =>
        Effect.gen(function* () {
          const last = entries.at(-1);
          const session = rooms.get(room);
          if (last === undefined || session === undefined) return;
          const tracks = yield* continueRadio(entries);
          yield* session.appendRadio(last.id, tracks);
        }).pipe(
          orDieOnDatabaseError("continueRadio"),
          Effect.provide(services),
          Effect.catchCause((cause) => Effect.logError("Cannot continue with radio", cause)),
        ),
      ),
    ),
  );

  // Only under `roomsLock`
  const createRoom = Effect.fn(function* (room: OutputId, name: string, initial: SessionState) {
    const session = yield* makeSession(
      room,
      initial,
      household,
      (sourceIds) => Queue.offerUnsafe(prefetches, { room, sourceIds }),
      (entries) => Queue.offerUnsafe(copyRequests, { room, entries }),
      (entries) => Queue.offerUnsafe(endings, { room, entries }),
      broadcastOutputs,
    ).pipe(Effect.provide(services));
    rooms.set(room, session);
    names.set(room, name);
    yield* Effect.forEach(
      household.connections,
      (connection) => session.subscribe(connection, name),
      {
        discard: true,
      },
    );
    return session;
  });

  // Only under `roomsLock`
  const dropRoom = Effect.fn(function* (room: OutputId) {
    const session = rooms.get(room);
    if (session === undefined) return;
    yield* session.endOpenPlay;
    rooms.delete(room);
    names.delete(room);
    yield* deleteSession(room).pipe(
      Effect.provideService(Database, db),
      orDieOnDatabaseError("deleteSession"),
    );
    for (const connection of household.connections) {
      if (!connection.rooms.delete(room)) continue;
      Queue.offerUnsafe(connection.events, SessionEvent.cases.RoomRemoved.make({ room }));
    }
  });

  const nameOf = (room: OutputId) =>
    outputs().find((output) => output.id === room)?.name ?? names.get(room) ?? room;

  // A room exists for each output that is online, and for each saved room
  const roomOf = (room: OutputId) =>
    roomsLock.withPermits(1)(
      Effect.suspend(() => {
        const session = rooms.get(room);
        if (session !== undefined) return Effect.succeed(session);
        if (!available(room)) {
          return Effect.fail(new SessionCommandFailed({ reason: "output_unavailable" }));
        }
        return createRoom(room, nameOf(room), emptyState);
      }),
    );

  for (const saved of yield* loadSessions) yield* createRoom(saved.room, saved.name, saved.state);

  // Plugin outputs belong to the household, so each one is a room. An empty room goes with its
  // output, also when the output becomes the hidden twin of a URL output.
  const refreshOutputs = roomsLock.withPermits(1)(
    Effect.gen(function* () {
      const listed = urlOutputs.list();
      for (const output of listed) {
        names.set(output.id, output.name);
        if (!rooms.has(output.id)) yield* createRoom(output.id, output.name, emptyState);
      }
      for (const [room, session] of rooms) {
        const gone = !isDeviceOutput(room) && !listed.some((output) => output.id === room);
        if (gone && (yield* session.idle)) yield* dropRoom(room);
      }
      broadcastOutputs();
    }),
  );
  yield* refreshOutputs;
  yield* Effect.forkScoped(
    Stream.runForEach(Stream.merge(urlOutputs.changes, receivers.changes), () => refreshOutputs),
  );

  // Other rooms give up the outputs that a room starts to play on
  const releaseFor = (room: OutputId, taken: ReadonlyArray<OutputId>) =>
    Effect.forEach(
      [...rooms].filter(([id]) => id !== room),
      ([, session]) => session.release(taken),
      { discard: true },
    );

  const attach = (
    connection: Connection,
    player: { readonly name: string; readonly volume: number } | null,
  ) =>
    roomsLock.withPermits(1)(
      Effect.gen(function* () {
        const own = deviceOutput(connection.deviceId);
        const generation = player === null ? 0 : household.nextGeneration;
        if (player !== null) {
          household.nextGeneration += 1;
          const earlier = household.players.get(own);
          if (earlier !== undefined) {
            Queue.offerUnsafe(earlier.connection.events, SessionEvent.cases.Superseded.make({}));
          }
          household.players.set(own, new Player({ generation, connection, ...player }));
          names.set(own, player.name);
          if (!rooms.has(own)) yield* createRoom(own, player.name, emptyState);
        }

        Queue.offerUnsafe(
          connection.events,
          SessionEvent.cases.Connected.make({
            generation,
            serverTime: yield* Clock.currentTimeMillis,
            outputs: outputs(),
            rooms: [...rooms.keys()],
          }),
        );
        household.connections.add(connection);
        yield* Effect.forEach(
          rooms,
          ([room, session]) => session.subscribe(connection, nameOf(room)),
          { discard: true },
        );
        broadcastOutputs();
        if (player !== null) yield* rooms.get(own)?.playerJoined ?? Effect.void;
      }),
    );

  const detach = (connection: Connection) =>
    Effect.suspend(() => {
      household.connections.delete(connection);
      const own = deviceOutput(connection.deviceId);
      if (household.players.get(own)?.connection !== connection) return Effect.void;

      household.players.delete(own);
      broadcastOutputs();
      return rooms.get(own)?.playerLeft ?? Effect.void;
    });

  /** `Connected`, a snapshot of each room, then the changes. A device with a `player` plays its room. */
  const connect = Effect.fn(function* (
    deviceId: DeviceId,
    player: { readonly name: string; readonly volume: number } | null,
  ) {
    const events = yield* Queue.unbounded<Event, Cause.Done>();
    const connection = new Connection({ deviceId, events, rooms: new Set() });

    yield* Effect.acquireRelease(attach(connection, player), () => detach(connection));
    return Stream.fromQueue(events);
  });

  // The queue moves in two steps, so that no room waits for the lock of another
  const transfer = Effect.fn(function* (from: OutputId, to: OutputId, play: boolean | null) {
    const source = yield* roomOf(from);
    const target = yield* roomOf(to);
    if (!available(to)) return yield* new SessionCommandFailed({ reason: "output_unavailable" });

    yield* releaseFor(to, [to]);
    const moved = yield* source.takeQueue;
    if (Option.isNone(moved)) {
      return yield* new SessionCommandFailed({ reason: "nothing_to_play" });
    }
    return yield* target.adoptQueue(moved.value, play);
  });

  const control = Effect.fn(function* (
    deviceId: DeviceId,
    room: OutputId,
    request: Parameters<Session["control"]>[1],
    sources: ReadonlyMap<string, SourceSummary>,
    disliked: ReadonlySet<string>,
  ) {
    const command = request.command;
    if (SessionCommand.guards.Transfer(command)) {
      return yield* transfer(room, command.room, command.play);
    }

    const session = yield* roomOf(room);
    if (SessionCommand.guards.SetGroup(command))
      yield* releaseFor(room, [room, ...command.members]);
    if (SessionCommand.isAnyOf(["Play", "JumpTo", "Resume", "Receive"])(command)) {
      yield* releaseFor(room, [room]);
    }
    return yield* session.control(deviceId, request, sources, disliked);
  });

  const report = (deviceId: DeviceId, received: Parameters<Session["report"]>[1]) =>
    rooms.get(deviceOutput(deviceId))?.report(deviceId, received) ?? Effect.void;

  /** Takes the device out of all rooms, removes its room and ends the device's streams */
  const removeDevice = Effect.fn(function* (deviceId: DeviceId) {
    const removed = deviceOutput(deviceId);
    yield* releaseFor(removed, [removed]);
    yield* roomsLock.withPermits(1)(dropRoom(removed));
    for (const connection of household.connections) {
      if (connection.deviceId === deviceId) Queue.endUnsafe(connection.events);
    }
  });

  const save = (room: OutputId, session: Session, all: boolean) =>
    session.changes(all).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (state) => saveSession(room, nameOf(room), state),
        }),
      ),
      orDieOnDatabaseError("saveSession"),
      Effect.catchCause((cause) => Effect.logError("Cannot save a room", cause)),
      Effect.provideService(Database, db),
    );
  const eachRoom = (run: (room: OutputId, session: Session) => Effect.Effect<void>) =>
    Effect.suspend(() =>
      Effect.forEach([...rooms], ([room, session]) => run(room, session), { discard: true }),
    );

  // Registered before the ticker, so that it runs after the ticker stopped
  yield* Effect.addFinalizer(() =>
    eachRoom((room, session) =>
      session.endOpenPlay.pipe(Effect.andThen(save(room, session, true))),
    ),
  );

  // Saves happen at most once a second
  yield* Effect.forkScoped(
    Effect.repeat(
      eachRoom((room, session) => session.tick.pipe(Effect.andThen(save(room, session, false)))),
      Schedule.spaced("1 second"),
    ),
  );

  return { connect, control, report, removeDevice };
});

/**
 * The rooms of this replica. They are replica-local, because commands and reports need one writer.
 */
export class Sessions extends Context.Service<Sessions, Effect.Success<typeof makeSessions>>()(
  "@dyad/server-core/Sessions",
) {}

export const sessionsLayer = Layer.effect(
  Sessions,
  makeSessions.pipe(orDieOnDatabaseError("loadSessions")),
);

// A search result is not in `source` until it plays, so its summary comes from the provider cache
const sourceSummaries = Effect.fn(function* (sourceIds: ReadonlyArray<string>) {
  const db = yield* Database;
  const rows = yield* playableSources(inArray(source.id, sourceIds));
  const summaries = new Map(rows.map((row) => [row.source.id, sourceSummary(row)]));

  const missing = sourceIds.filter((id) => !summaries.has(id));
  if (missing.length === 0) return summaries;

  const providers = yield* usableProviders;
  const cached = yield* db
    .select({
      sourceId: providerItem.sourceId,
      provider: providerItem.provider,
      data: providerItem.data,
    })
    .from(providerItem)
    .where(
      and(
        inArray(providerItem.sourceId, missing),
        inArray(providerItem.provider, [...providers.keys()]),
      ),
    );
  for (const row of cached) {
    const item = yield* Schema.decodeUnknownEffect(ProviderSource)(row.data).pipe(Effect.orDie);
    summaries.set(
      row.sourceId,
      new SourceSummary({
        id: row.sourceId,
        provider: row.provider,
        title: item.title,
        artist: item.artist,
        album: item.album,
        durationMs: item.durationMs,
        codec: item.codec,
        artworkUrl: item.artworkUrl,
        artistRef: null,
        albumRef: null,
        explicit: item.explicit ?? false,
        providerName: providers.get(row.provider)?.provider.name ?? null,
        video: item.video,
      }),
    );
  }
  return summaries;
});

export const connectDevice = Effect.fn("connectDevice")(function* (payload: {
  readonly player: { readonly volume: number } | null;
}) {
  const principal = yield* CurrentPrincipal;
  const db = yield* Database;
  const sessions = yield* Sessions;

  const [row] =
    payload.player === null
      ? []
      : yield* db
          .select({ name: device.name })
          .from(device)
          .where(eq(device.id, principal.deviceId))
          .limit(1);
  const player =
    payload.player === null || row === undefined
      ? null
      : { name: row.name, volume: payload.player.volume };
  return yield* sessions.connect(principal.deviceId, player);
});

export const controlSession = Effect.fn("controlSession")(function* (
  request: Parameters<Session["control"]>[1] & { readonly room: OutputId },
) {
  const principal = yield* CurrentPrincipal;
  const sessions = yield* Sessions;
  const command = request.command;
  const sources =
    SessionCommand.guards.Play(command) || SessionCommand.guards.Enqueue(command)
      ? yield* sourceSummaries(command.sourceIds)
      : new Map<string, SourceSummary>();
  const dislikes = SessionCommand.guards.Play(command) ? yield* loadDisliked : new Set<string>();
  const disliked = new Set(
    [...sources.values()].flatMap((summary) => (isDisliked(dislikes, summary) ? [summary.id] : [])),
  );
  return yield* sessions.control(principal.deviceId, request.room, request, sources, disliked);
});

export const reportPlayback = Effect.fn("reportPlayback")(function* (
  report: Parameters<Session["report"]>[1],
) {
  const principal = yield* CurrentPrincipal;
  yield* (yield* Sessions).report(principal.deviceId, report);
});
