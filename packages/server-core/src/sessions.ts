import { device, providerItem, source } from "@dyad/db";
import { Database, orDieOnDatabaseError } from "@dyad/db/node";
import {
  CurrentPrincipal,
  EntryId,
  Output,
  OutputId,
  Playback,
  PlayerResume,
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
import { hintPrefetch } from "./playback.ts";
import { Receivers, deviceOutput } from "./receivers.ts";
import { usableProviders } from "./providers.ts";
import { SessionState, loadSession, saveSession } from "./session-store.ts";
import { continueRadio } from "./radio.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { TimedDesired, driveTimedOutputs } from "./timed-output.ts";
import type { TimedDriver } from "./timed-output.ts";
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

// The play of the current entry since the output started it
class OpenPlay extends Data.Class<{
  readonly entry: QueueEntry;
  readonly deviceId: DeviceId;
  readonly startedAt: number;
  readonly playedMs: number;
  // `null` while the clock stands
  readonly resumedAt: number | null;
}> {}

const makeSession = (
  initial: SessionState,
  prefetch: (sourceIds: ReadonlyArray<string>) => void,
  queueEnds: (entries: ReadonlyArray<QueueEntry>) => void,
) =>
  Effect.gen(function* () {
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
      nextGeneration: 1,
      connections: new Set<Connection>(),
      players: new Map<OutputId, Player>(),
      requests: new Map<string, RememberedResult>(),
      // Changed since the last save
      dirty: false,
      play: Option.none<OpenPlay>(),
      // The entry that ended by itself in this change. Its play is complete.
      ended: Option.none<EntryId>(),
      // The sources of the last prefetch hint, joined
      prefetched: "",
      // Set while the output is a URL output
      urlDriver: Option.none<UrlDriver>(),
      // Set while the output is a timed output
      timedDriver: Option.none<TimedDriver>(),
      // The drivers that close now. A new driver waits for them, else the last commands of an old
      // driver can stop a device that the new one started, for example a Sonos that leaves AirPlay.
      closing: Effect.void,
      // A play on a URL output counts for the device that sent the last command
      commandDevice: Option.none<DeviceId>(),
      // The play of an entry that the output started offline. The server continues it.
      handover: Option.none<PlayerResume>(),
      // The entry that asked for radio songs last, so that it asks once
      refilled: Option.none<EntryId>(),
    };

    const broadcast = (event: Event) => {
      for (const connection of state.connections) Queue.offerUnsafe(connection.events, event);
    };

    const outputs = () => [
      ...[...state.players].map(
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

    const available = (outputId: OutputId) =>
      state.players.has(outputId) || urlOutputs.has(outputId);

    const timedCapable = (outputId: OutputId) =>
      state.players.has(outputId)
        ? receivers.has(outputId)
        : urlOutputs.has(outputId) && urlOutputs.timedCapable(outputId);

    // In a timed group, or in a group of URL outputs that the plugin groups
    const groupable = (outputId: OutputId) =>
      timedCapable(outputId) || (!state.players.has(outputId) && urlOutputs.joinable([outputId]));

    // A group plays through the renderer, unless its plugin groups it, for example a group of Sonos
    // only. A URL output or a device alone plays by itself.
    const timedRoute = () => {
      const { outputId, group } = state.playback;
      if (outputId === null) return false;
      const members = [outputId, ...group];
      return urlOutputs.isTimed(outputId) || (group.length > 0 && !urlOutputs.isNative(members));
    };

    const broadcastOutputs = () =>
      broadcast(SessionEvent.cases.OutputsChanged.make({ outputs: outputs() }));

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
          fromVersion,
          version: state.queueVersion,
          splices,
        }),
      );
    };

    const createEntries = (
      sources: ReadonlyArray<SourceSummary>,
      context: typeof PlayContext.Type,
      reasons: Readonly<Record<string, string>> = {},
    ) =>
      sources.map((summary) => {
        const id = EntryId.make(state.nextEntryId);
        state.nextEntryId += 1;
        const reason = reasons[summary.id] ?? null;
        return new QueueEntry({ id, source: summary, context, unplayable: false, reason });
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

    // The sender plays when the output is offline and the sender can play (Spotify Connect)
    const claimOutput = (deviceId: DeviceId) => {
      const current = state.playback.outputId;
      if (current !== null && available(current)) return current;

      const own = deviceOutput(deviceId);
      return state.players.has(own) ? own : current;
    };

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
    const trackPlay = (now: number) =>
      Effect.gen(function* () {
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

        state.handover = Option.filter(
          state.handover,
          (resume) => resume.entryId === playback.entryId,
        );
        const entry = currentEntry();
        const output =
          playback.outputId === null ? undefined : state.players.get(playback.outputId);
        const deviceId =
          output?.connection.deviceId ??
          (Option.isSome(state.urlDriver) || Option.isSome(state.timedDriver)
            ? Option.getOrUndefined(state.commandDevice)
            : undefined);
        if (Option.isNone(state.play) && playback.rate === 1 && entry && deviceId) {
          const handover = Option.getOrUndefined(state.handover)?.play;
          state.handover = Option.none();
          state.play = Option.some(
            new OpenPlay({
              entry,
              deviceId,
              startedAt: handover?.startedAt ?? now,
              playedMs: handover?.playedMs ?? 0,
              resumedAt: now,
            }),
          );
        }
      });

    // The next two entries that a skip or the end of an entry can start
    const upcomingSources = () => {
      const { entryId, repeat, state: transport } = state.playback;
      // A paused session can wait for weeks, for example after a restart
      if (transport !== "playing") return [];

      const first = nextEntry(state.entries, entryId, repeat, "skip");
      const second = first && nextEntry(state.entries, first.id, repeat, "skip");
      const entries = [first, second].filter((entry) => entry && entry.id !== entryId);
      return [...new Set(entries.flatMap((entry) => entry?.source.id ?? []))];
    };

    // The current entry and the entries that follow it, until one repeats
    const playOrder = () => {
      const first = currentEntry();
      if (first === undefined) return [];
      const order = [first];
      while (order.length < timedWindow) {
        const next = nextEntry(
          state.entries,
          order.at(-1)?.id ?? null,
          state.playback.repeat,
          "end",
        );
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

          const upcoming = upcomingSources();
          if (upcoming.join(" ") !== state.prefetched) {
            state.prefetched = upcoming.join(" ");
            prefetch(upcoming);
          }
          const { entryId, repeat, autoplay } = state.playback;
          const ends = upcoming.length === 0 && repeat === "off" && autoplay && entryId !== null;
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
      deviceId: DeviceId,
      command: Command,
      sources: ReadonlyMap<string, SourceSummary>,
      now: number,
    ) => {
      const playback = state.playback;
      const position = positionAt(playback, now);

      const transfer = (outputId: OutputId, play: boolean | null, group: ReadonlyArray<OutputId>) =>
        Effect.gen(function* () {
          if (!available(outputId)) return yield* fail("output_unavailable");

          if (play ?? playback.state === "playing") {
            const entry = currentEntry() ?? nextEntry(state.entries, null, playback.repeat, "skip");
            if (entry === undefined) return yield* fail("nothing_to_play");

            const continues = playback.state !== "stopped" && entry.id === playback.entryId;
            start(entry.id, continues ? position : 0, now, outputId);
            setPlayback({ group });
            return [];
          }

          setPlayback({
            state: playback.state === "stopped" ? "stopped" : "paused",
            positionMs: playback.state === "stopped" ? 0 : position,
            at: now,
            rate: 0,
            revision: playback.revision + 1,
            outputId,
            group,
            lost: false,
          });
          return [];
        });

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
                const before = listed[index - 1];
                const repeats =
                  index !== command.index && before !== undefined && isSameSong(before, summary);
                return repeats ? [] : [{ summary, index }];
              });
              const selected = kept.find((item) => item.index >= command.index) ?? kept.at(-1);
              if (selected === undefined) return yield* fail("nothing_to_play");

              // With shuffle, the whole list plays in random order, not only the part after `index`
              const others = kept.filter((item) => item !== selected);
              const ordered = command.shuffle
                ? [selected, ...(yield* Random.shuffle(others))]
                : kept;
              const entries = createEntries(
                ordered.map((item) => item.summary),
                command.context,
                command.reasons,
              );
              const first = entries[ordered.indexOf(selected)];
              if (first === undefined) return yield* fail("nothing_to_play");

              spliceQueue([
                new QueueSplice({ index: 0, remove: state.entries.length, insert: entries }),
              ]);
              state.failures = 0;
              setPlayback({ shuffle: command.shuffle });
              start(first.id, 0, now, claimOutput(deviceId));
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

              const entries = createEntries(summaries, command.context);
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

              spliceQueue([
                new QueueSplice({ index: 0, remove: state.entries.length, insert: [] }),
              ]);
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
              start(entry.id, command.positionMs, now, claimOutput(deviceId));
              return [];
            }),

          Resume: () =>
            Effect.gen(function* () {
              if (playback.state === "playing") return [];

              const outputId = claimOutput(deviceId);
              if (outputId === null) return yield* fail("output_unavailable");

              const entry =
                currentEntry() ?? nextEntry(state.entries, null, playback.repeat, "skip");
              if (entry === undefined) return yield* fail("nothing_to_play");

              const continues = playback.state === "paused" && entry.id === playback.entryId;
              start(entry.id, continues ? position : 0, now, outputId);
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

          Transfer: (command) => transfer(command.outputId, command.play, []),

          SetGroup: (command) =>
            Effect.gen(function* () {
              const first = command.outputIds[0];
              const all = [...new Set(command.outputIds)];
              const rest = all.slice(1);
              if (!all.every(timedCapable) && !urlOutputs.joinable(all)) {
                return yield* fail("output_unavailable");
              }

              // An output that plays already keeps playing, so the change needs no new transport
              const members =
                playback.outputId === null ? [] : [playback.outputId, ...playback.group];
              const kept = members.find((id) => all.includes(id));
              if (kept === undefined) return yield* transfer(first, null, rest);

              setPlayback({ outputId: kept, group: all.filter((id) => id !== kept) });
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
              const player = state.players.get(command.outputId);
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

              state.players.set(
                command.outputId,
                new Player({ ...player, volume: command.volume }),
              );
              broadcastOutputs();
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
    ) =>
      modify((now) =>
        Effect.gen(function* () {
          state.commandDevice = Option.some(deviceId);
          const remembered = state.requests.get(request.requestId);
          if (remembered !== undefined) return yield* remembered.exit;

          const exit = yield* Effect.exit(
            Effect.gen(function* () {
              if (
                request.ifQueueVersion !== null &&
                request.ifQueueVersion !== state.queueVersion
              ) {
                return yield* fail("stale_queue");
              }

              const entryIds = yield* apply(deviceId, request.command, sources, now);
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
          const player = state.players.get(outputId);
          if (player?.generation !== received.generation) return;
          if (state.playback.outputId !== outputId) return;

          if (received.volume !== player.volume) {
            state.players.set(outputId, new Player({ ...player, volume: received.volume }));
            broadcastOutputs();
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
          if (!current) return;
          const { outputId, group } = state.playback;
          if (outputId === null) return;
          const [first, ...rest] = [outputId, ...group].filter((id) => id !== taken);
          if (first === undefined) dropOutput(now);
          else setPlayback({ outputId: first, group: rest });
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

    const addPlayer = (
      connection: Connection,
      generation: number,
      player: { readonly name: string; readonly volume: number },
      resume: PlayerResume | null,
      now: number,
    ) => {
      const outputId = deviceOutput(connection.deviceId);
      const earlier = state.players.get(outputId);
      if (earlier !== undefined) {
        Queue.offerUnsafe(earlier.connection.events, SessionEvent.cases.Superseded.make({}));
      }
      state.players.set(outputId, new Player({ generation, connection, ...player }));
      broadcastOutputs();

      const playback = state.playback;
      if (playback.outputId !== outputId) return;

      // The device played on while it was away, and nobody changed the transport since
      const adopts =
        resume !== null &&
        playback.group.length === 0 &&
        resume.revision >= playback.revision &&
        indexOf(resume.entryId) !== -1;
      if (adopts) {
        // An entry that ended on the device offline has a complete play, as after a natural end
        if (playback.entryId !== null && resume.advanced.includes(playback.entryId)) {
          state.ended = Option.some(playback.entryId);
        }
        if (resume.play !== null) state.handover = Option.some(resume);
      }
      setPlayback(
        adopts
          ? {
              state: resume.state,
              entryId: resume.entryId,
              positionMs: resume.positionMs,
              at: now,
              rate: resume.state === "playing" ? 1 : 0,
              revision: resume.revision,
              lost: false,
            }
          : { lost: false },
      );
    };

    const attach = (
      connection: Connection,
      player: { readonly name: string; readonly volume: number } | null,
      resume: PlayerResume | null,
    ) =>
      modify((now) =>
        Effect.sync(() => {
          const generation = player === null ? 0 : state.nextGeneration;
          if (player !== null) {
            state.nextGeneration += 1;
            addPlayer(connection, generation, player, resume, now);
          }

          Queue.offerUnsafe(
            connection.events,
            SessionEvent.cases.Snapshot.make({
              generation,
              serverTime: now,
              queueVersion: state.queueVersion,
              entries: state.entries,
              playback: state.playback,
              outputs: outputs(),
            }),
          );
          state.connections.add(connection);
        }),
      );

    const detach = (connection: Connection) =>
      modify(() =>
        Effect.sync(() => {
          state.connections.delete(connection);

          const outputId = deviceOutput(connection.deviceId);
          if (state.players.get(outputId)?.connection !== connection) return;

          state.players.delete(outputId);
          broadcastOutputs();
          // In a group, the renderer finds that the device is gone
          if (state.playback.outputId === outputId && state.playback.group.length === 0) {
            setPlayback({ lost: true });
          }
        }),
      );

    /** A `Snapshot`, then the changes. A device with a `player` can be the output. */
    const connect = (
      deviceId: DeviceId,
      player: { readonly name: string; readonly volume: number } | null,
      resume: PlayerResume | null,
    ) =>
      Effect.gen(function* () {
        const events = yield* Queue.unbounded<Event, Cause.Done>();
        const connection = new Connection({ deviceId, events });

        yield* Effect.acquireRelease(attach(connection, player, resume), () => detach(connection));
        return Stream.fromQueue(events);
      });

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

    const refreshOutputs = lock.withPermits(1)(Effect.sync(broadcastOutputs));

    /** Pauses the session when the device is the output, and ends the device's streams */
    const removeDevice = (deviceId: DeviceId) =>
      modify((now) =>
        Effect.sync(() => {
          const removed = deviceOutput(deviceId);
          const { outputId, group } = state.playback;
          if (group.includes(removed)) setPlayback({ group: group.filter((id) => id !== removed) });
          else if (outputId === removed) {
            const [first, ...rest] = group;
            if (first === undefined) dropOutput(now);
            else setPlayback({ outputId: first, group: rest });
          }
          for (const connection of state.connections) {
            if (connection.deviceId === deviceId) Queue.endUnsafe(connection.events);
          }
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
        if (
          playback.state === "playing" &&
          !playback.lost &&
          reports &&
          now > state.reportDeadline
        ) {
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
            reasons,
          );
          spliceQueue([new QueueSplice({ index: state.entries.length, remove: 0, insert })]);
        }),
      );

    return {
      connect,
      control,
      report,
      removeDevice,
      refreshOutputs,
      tick,
      endOpenPlay,
      changes,
      appendRadio,
    };
  });

type Session = Effect.Success<ReturnType<typeof makeSession>>;

const makeSessions = Effect.gen(function* () {
  const db = yield* Database;
  const services =
    yield* Effect.context<
      Effect.Services<ReturnType<typeof makeSession | typeof hintPrefetch | typeof continueRadio>>
    >();

  // In order, so that the last hint wins
  const prefetches = yield* Queue.unbounded<ReadonlyArray<string>>();
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(prefetches), (sourceIds) =>
        hintPrefetch("session", sourceIds).pipe(
          orDieOnDatabaseError("hintPrefetch"),
          Effect.catchCause((cause) => Effect.logError("Cannot prefetch for the session", cause)),
        ),
      ),
    ),
  );

  // Radio requests take seconds, so they run outside the session lock
  const endings = yield* Queue.unbounded<ReadonlyArray<QueueEntry>>();
  const session = yield* makeSession(
    Option.getOrElse(yield* loadSession, () => emptyState),
    (sourceIds) => Queue.offerUnsafe(prefetches, sourceIds),
    (entries) => Queue.offerUnsafe(endings, entries),
  ).pipe(Effect.provide(services));
  yield* Effect.forkScoped(
    Effect.forever(
      Effect.flatMap(Queue.take(endings), (entries) =>
        Effect.gen(function* () {
          const last = entries.at(-1);
          if (last === undefined) return;
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

  // Plugin outputs belong to the household, so the session lists them
  yield* Effect.forkScoped(
    Stream.runForEach(
      Stream.merge((yield* Outputs).changes, (yield* Receivers).changes),
      () => session.refreshOutputs,
    ),
  );

  const save = (all: boolean) =>
    session.changes(all).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (state) => saveSession(state),
        }),
      ),
      orDieOnDatabaseError("saveSession"),
      Effect.catchCause((cause) => Effect.logError("Cannot save the playback session", cause)),
      Effect.provideService(Database, db),
    );

  // Registered before the ticker, so that it runs after the ticker stopped
  yield* Effect.addFinalizer(() => session.endOpenPlay.pipe(Effect.andThen(save(true))));

  // Saves happen at most once a second
  yield* Effect.forkScoped(
    Effect.repeat(session.tick.pipe(Effect.andThen(save(false))), Schedule.spaced("1 second")),
  );

  return { session };
});

/**
 * The playback session of this replica. It is replica-local, because commands and reports need one
 * writer.
 */
export class Sessions extends Context.Service<Sessions, Effect.Success<typeof makeSessions>>()(
  "@dyad/server-core/Sessions",
) {}

export const sessionsLayer = Layer.effect(
  Sessions,
  makeSessions.pipe(orDieOnDatabaseError("loadSession")),
);

// A search result is not in `source` until it plays, so its summary comes from the provider cache
const sourceSummaries = (sourceIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
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

export const connectDevice = (payload: {
  readonly player: { readonly volume: number } | null;
  readonly resume: PlayerResume | null;
}) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const db = yield* Database;
    const session = (yield* Sessions).session;

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
    return yield* session.connect(principal.deviceId, player, payload.resume);
  });

export const controlSession = (request: Parameters<Session["control"]>[1]) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const session = (yield* Sessions).session;
    const command = request.command;
    const sources =
      SessionCommand.guards.Play(command) || SessionCommand.guards.Enqueue(command)
        ? yield* sourceSummaries(command.sourceIds)
        : new Map<string, SourceSummary>();
    return yield* session.control(principal.deviceId, request, sources);
  });

export const reportPlayback = (report: Parameters<Session["report"]>[1]) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const session = (yield* Sessions).session;
    yield* session.report(principal.deviceId, report);
  });
