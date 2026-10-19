import { ServerConnection, deviceOutputId, positionOf, titleOf } from "@dyad/client-runtime";
import type { Downloads, SessionClient, SessionView } from "@dyad/client-runtime";
import { PlaybackUnavailable, nextEntry } from "@dyad/domain";
import type { EntryId, QueueEntry, RepeatMode } from "@dyad/domain";
import type { Audio } from "@opentui/core";
import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { FileSystem } from "effect";
import type { HttpClient } from "effect/http";

import { describeFailure } from "../log.ts";
import { downloadState, downloadedBytes, fetchFile, fetchSource, openTrack } from "./player.ts";
import type { Fetched, Track } from "./player.ts";

// A smaller difference between the session and the audio is report jitter, not a seek
const seekThresholdMs = 1000;
// The device keeps the audio of this many next entries, so that it can play on without the server
const bufferedAhead = 3;
// No download of a next entry starts while the next entries use more memory than this
const bufferBudgetBytes = 256 * 1024 * 1024;

// The transport of the session that the engine followed last
class Followed extends Data.Class<{
  readonly generation: number;
  readonly revision: number;
  readonly entryId: EntryId | null;
}> {}

const nothingFollowed = new Followed({ generation: -1, revision: -1, entryId: null });

// The download of one entry. Closing `scope` stops it.
class Buffered extends Data.Class<{
  readonly scope: Scope.Closeable;
  // The server of the stream, also for seeks
  readonly url: string;
  readonly fetching: Fiber.Fiber<Fetched, Effect.Error<ReturnType<typeof fetchSource>>>;
}> {}

const settled = (buffered: Buffered) => {
  const exit = buffered.fetching.pollUnsafe();
  return exit !== undefined && (Exit.isFailure(exit) || downloadState(exit.value) !== "loading");
};

const failed = (buffered: Buffered) => {
  const exit = buffered.fetching.pollUnsafe();
  return exit !== undefined && (Exit.isFailure(exit) || downloadState(exit.value) === "failed");
};

const bytesOf = (buffered: Buffered) => {
  const exit = buffered.fetching.pollUnsafe();
  return exit !== undefined && Exit.isSuccess(exit) ? downloadedBytes(exit.value) : 0;
};

// The next entries in the order of skips, which ignore `repeat: "one"`
const upcoming = (
  entries: ReadonlyArray<QueueEntry>,
  entryId: EntryId,
  repeat: typeof RepeatMode.Type,
) => {
  const result: Array<QueueEntry> = [];
  let from = entryId;
  while (result.length < bufferedAhead) {
    const next = nextEntry(entries, from, repeat, "skip");
    if (next === undefined || next.id === entryId || result.includes(next)) break;
    result.push(next);
    from = next.id;
  }
  return result;
};

// The text stays until the next entry, so that the user can read why nothing plays
const failureText = (error: Option.Option<unknown>, title: string) => {
  if (Option.isNone(error) || !Schema.is(PlaybackUnavailable)(error.value)) {
    return `Cannot play ${title}`;
  }

  if (error.value.reason === "account_required") return `Link an account to play ${title}`;
  if (error.value.reason === "not_found") return `${title} is no longer available`;
  return `Cannot play ${title}`;
};

// In a group, the server's renderer plays the audio of this device too
const isMine = (view: SessionView) =>
  view.deviceId !== null &&
  view.playback.outputId === deviceOutputId(view.deviceId) &&
  view.playback.group.length === 0 &&
  !view.superseded;

const makeEngine = Effect.fn(function* (options: {
  readonly audio: Audio;
  readonly serverUrl: string;
  readonly volume: number;
  readonly saveVolume: (volume: number) => Effect.Effect<void>;
  /** The replica of this device, which plays the room of the device without the home server */
  readonly local: {
    readonly url: string;
    readonly connection: typeof ServerConnection.Service;
  } | null;
  /** A downloaded file plays first, also without the server */
  readonly downloads: typeof Downloads.Service | null;
}) {
  const connection = yield* ServerConnection;
  const services = yield* Effect.context<
    ServerConnection | HttpClient.HttpClient | FileSystem.FileSystem
  >();
  const audio = options.audio;

  // Changed only by the fiber of `run`
  let followed = nothingFollowed;
  // What this device plays. After an entry ends, it is ahead of the session for a moment.
  let current: EntryId | null = null;
  let playing = false;
  // The position while no track is loaded
  let positionMs = 0;
  let track: Track | null = null;
  let trackScope: Scope.Closeable | null = null;
  // Tells the fibers of replaced tracks apart
  let token = 0;
  // The last revision that the server accepted a report for
  let reportedRevision = -1;
  let volume = options.volume;

  const positionNow = () => track?.position() ?? positionMs;

  // A file that went away, for example at the end of its lease, falls back to the server
  const fetchEntry = (entry: QueueEntry, server: { readonly url: string }) => {
    const stream = fetchSource(server.url, entry);
    if (options.downloads === null) return stream;
    return options.downloads.file(entry.source.id).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => stream,
          onSome: (file) =>
            fetchFile(file.path, file.format, file.audio).pipe(Effect.catch(() => stream)),
        }),
      ),
    );
  };

  const stopAudio = Effect.suspend(() => {
    const closing = trackScope;
    positionMs = positionNow();
    track = null;
    trackScope = null;
    token += 1;
    return closing === null ? Effect.void : Scope.close(closing, Exit.void);
  });

  const run = Effect.fn(
    function* (
      session: typeof SessionClient.Service,
      callbacks: {
        /** `null` when an entry starts */
        readonly onFailure: (text: string | null) => void;
        readonly onNotice: (text: string) => void;
      },
    ) {
      const actions = yield* Queue.unbounded<Effect.Effect<void>>();
      const latest = SubscriptionRef.get(session.own);
      // The replica that runs the room of this device: the home server, or the local replica
      const serverOf = (view: SessionView) =>
        view.replica === "local" && options.local !== null
          ? { url: options.local.url, connection: options.local.connection }
          : { url: options.serverUrl, connection };
      const buffers = new Map<EntryId, Buffered>();
      // Entries that failed once before their audio started. The next plan of the server skips
      // the source that failed, so one more start can play another source of the recording.
      const retried = new Set<EntryId>();
      let disconnected = true;

      const dropBuffer = (entryId: EntryId) => {
        const buffered = buffers.get(entryId);
        buffers.delete(entryId);
        return buffered === undefined ? Effect.void : Scope.close(buffered.scope, Exit.void);
      };

      // A failed download stays until `failedTrack` or a reconnect drops it, so that a failed
      // next entry does not ask the server a second time when it starts
      const bufferOf = Effect.fn(function* (entry: QueueEntry) {
        const existing = buffers.get(entry.id);
        if (existing !== undefined) return existing;

        const scope = yield* Scope.make();
        const server = serverOf(yield* latest);
        const fetching = yield* fetchEntry(entry, server).pipe(
          Scope.provide(scope),
          Effect.provideContext(services),
          Effect.provideService(ServerConnection, server.connection),
          Effect.forkIn(scope),
        );
        // The next download starts when this one ends
        yield* Fiber.join(fetching).pipe(
          Effect.flatMap((fetched) =>
            SubscriptionRef.changes(fetched.download.received).pipe(
              Stream.takeUntil((received) => received.state !== "loading"),
              Stream.runDrain,
            ),
          ),
          Effect.ignore,
          Effect.andThen(Queue.offer(actions, Effect.void)),
          Effect.forkIn(scope),
        );
        const created = new Buffered({ scope, fetching, url: server.url });
        buffers.set(entry.id, created);
        return created;
      });

      // Keeps the current entry, the one before it and the next ones. Online, it downloads the
      // next entries one at a time.
      const syncBuffers = Effect.gen(function* () {
        const view = yield* latest;
        const playback = view.playback;
        const at = isMine(view) ? current : null;
        const ahead = at === null ? [] : upcoming(view.entries, at, playback.repeat);
        const previous =
          at === null ? undefined : nextEntry(view.entries, at, playback.repeat, "skip", -1);
        const kept = new Set([at, previous?.id, ...ahead.map((entry) => entry.id)]);
        for (const entryId of buffers.keys()) {
          if (!kept.has(entryId)) yield* dropBuffer(entryId);
        }

        const own = at === null ? undefined : buffers.get(at);
        if (!view.connected || playback.state !== "playing" || (own && !settled(own))) return;

        let bytes = 0;
        for (const entry of ahead) {
          const buffered = buffers.get(entry.id);
          if (buffered === undefined) {
            if (bytes < bufferBudgetBytes) yield* bufferOf(entry);
            return;
          }
          if (!settled(buffered)) return;
          bytes += bytesOf(buffered);
        }
      });

      const report = Effect.fn(function* (
        view: SessionView,
        fields: {
          readonly entryId: EntryId;
          readonly state: "playing" | "paused" | "buffering" | "ended" | "failed";
          readonly positionMs: number;
          readonly failure: PlaybackUnavailable["reason"] | null;
        },
      ) {
        if (!view.connected) return;

        const revision = followed.revision;
        // The server ignores a report of a revision that it does not know yet
        if (view.confirmed.revision === revision) reportedRevision = revision;
        yield* session
          .report(view, { ...fields, revision, volume })
          .pipe(Effect.timeout("2 seconds"), Effect.ignore);
      });

      const reportState = (view: SessionView) => {
        if (current === null) return Effect.void;

        const loading = trackScope !== null && track === null;
        const audible = playing && track !== null;
        const state = audible ? "playing" : "paused";
        return report(view, {
          entryId: current,
          state: loading ? "buffering" : state,
          positionMs: positionNow(),
          failure: null,
        });
      };

      // A report under the revision of this client's own command waits until the server has it
      const reportConfirmed = (view: SessionView) =>
        view.confirmed.revision === view.playback.revision &&
        reportedRevision !== view.playback.revision
          ? reportState(view)
          : Effect.void;

      // The failure text of the entry before stays until audio plays
      const started = Effect.fn(function* (opened: number, loaded: Track, copy: string | null) {
        if (opened !== token) return;
        track = loaded;
        callbacks.onFailure(null);
        if (copy !== null) callbacks.onNotice(`Playing ${copy}`);
        yield* reportState(yield* latest);
      });

      const open = Effect.fn(function* (entry: QueueEntry, startMs: number) {
        yield* stopAudio;
        const opened = token;
        const buffered = yield* bufferOf(entry);
        const scope = yield* Scope.make();
        current = entry.id;
        positionMs = startMs;
        trackScope = scope;
        playing = true;
        audio.start();

        const play = Effect.gen(function* () {
          const fetched = yield* Fiber.join(buffered.fetching);
          const loaded = yield* openTrack(audio, buffered.url, fetched, startMs);
          yield* Queue.offer(actions, started(opened, loaded, fetched.copy));
          yield* loaded.ended;
        });

        yield* play.pipe(
          Effect.matchCauseEffect({
            onSuccess: () => Queue.offer(actions, ended(opened)),
            onFailure: (cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.void
                : Queue.offer(actions, failedTrack(opened, entry, cause)),
          }),
          Scope.provide(scope),
          Effect.provideContext(services),
          Effect.forkIn(scope),
        );
      });

      // RETURN TYPE: `open` and the functions that it calls back refer to each other
      const failedTrack = Effect.fn(function* (
        opened: number,
        entry: QueueEntry,
        cause: Cause.Cause<unknown>,
      ): Effect.fn.Return<void> {
        if (opened !== token) return;
        yield* Effect.logWarning("Cannot play", describeFailure(cause)).pipe(
          Effect.annotateLogs({ sourceId: entry.source.id, provider: entry.source.provider }),
        );
        const audible = track !== null;
        yield* stopAudio;
        playing = false;
        // A later start, for example a jump to the entry, asks the server again
        yield* dropBuffer(entry.id);

        const view = yield* latest;
        // Without the server, the entry did not fail. It waits for the connection, or for the
        // replica that takes over the room.
        const error = Cause.findErrorOption(cause);
        const lost = Option.exists(error, Predicate.isTagged("RpcClientError"));
        if (lost && !view.connected) return;

        // The server marks a source that failed before its first byte, and the next plan
        // tries the other sources of the recording. A plan that fails needs no second try.
        const planFailed = Option.exists(error, Schema.is(PlaybackUnavailable));
        if ((lost || !audible) && !planFailed && !retried.has(entry.id)) {
          retried.add(entry.id);
          return yield* open(entry, positionMs);
        }

        callbacks.onFailure(failureText(error, titleOf(entry.source)));
        const unavailable = Option.filter(error, Schema.is(PlaybackUnavailable));
        yield* report(view, {
          entryId: entry.id,
          state: "failed",
          positionMs,
          failure: Option.match(unavailable, {
            onNone: () => null,
            onSome: (value) => value.reason,
          }),
        });
      });

      // The engine starts the next entry itself, then reports the end, so that the gap stays
      // short. The server then makes the next entry current.
      // RETURN TYPE: see `failedTrack`
      const ended = Effect.fn(function* (opened: number): Effect.fn.Return<void> {
        const entryId = current;
        if (opened !== token || entryId === null) return;

        const view = yield* latest;
        // The replica that takes over the room continues from here
        if (!view.connected) {
          yield* stopAudio;
          playing = false;
          return;
        }

        const next = nextEntry(view.entries, entryId, view.playback.repeat, "end");
        const endMs = positionNow();
        if (next === undefined) {
          yield* stopAudio;
          playing = false;
        } else {
          yield* open(next, 0);
        }
        yield* report(view, { entryId, state: "ended", positionMs: endMs, failure: null });
      });

      const setVolume = (value: number) => {
        volume = value;
        audio.setMasterVolume(volume);
        return options.saveVolume(volume);
      };

      const applyVolume = (view: SessionView) => {
        const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
        const output = view.outputs.find((candidate) => candidate.id === own);
        if (output?.volume == null || output.volume === volume) return Effect.void;
        return setVolume(output.volume);
      };

      // Reports at once, so that the room does not mark this output as lost
      const reconnected = Effect.gen(function* () {
        reportedRevision = -1;
        for (const [entryId, buffered] of buffers) {
          if (failed(buffered)) yield* dropBuffer(entryId);
        }
      });

      const reconcile = Effect.fn(function* (view: SessionView) {
        yield* applyVolume(view);
        // The audio plays on until the room continues on a replica
        if (!view.connected) {
          disconnected = true;
          return;
        }
        // A restart of the server can repeat a generation, so only the view shows a new connection
        if (disconnected) {
          disconnected = false;
          yield* reconnected;
        }

        const playback = view.playback;
        const before = followed;
        followed = new Followed({
          generation: view.generation,
          revision: playback.revision,
          entryId: playback.entryId,
        });

        const entry = view.entries.find((candidate) => candidate.id === playback.entryId);
        if (!isMine(view) || playback.state === "stopped" || entry === undefined) {
          yield* stopAudio;
          current = null;
          playing = false;
          return;
        }

        // After the engine started the next entry itself, the session follows a moment later
        const unchanged =
          before.generation === view.generation &&
          before.revision === playback.revision &&
          (playback.entryId === before.entryId || playback.entryId === current);
        if (unchanged) return yield* reportConfirmed(view);

        const play = playback.state === "playing";
        const target = positionOf(view, yield* Clock.currentTimeMillis);

        if (current !== entry.id) {
          yield* stopAudio;
          current = entry.id;
          positionMs = target;
          playing = false;
          if (play) yield* open(entry, target);
          return yield* reportConfirmed(view);
        }

        const moved = Math.abs(target - positionNow()) > seekThresholdMs;
        if (track !== null && moved) yield* track.seek(target);
        if (track === null && (moved || trackScope === null)) {
          yield* stopAudio;
          positionMs = target;
          if (play) yield* open(entry, target);
        }

        playing = play;
        if (play) audio.start();
        else audio.stop();
        yield* reportConfirmed(view);
      });

      const tick = Effect.gen(function* () {
        if (track !== null && playing) yield* reportState(yield* latest);
      });

      // After a restart of the app, the engine starts from the session again
      followed = nothingFollowed;
      audio.setMasterVolume(volume);
      yield* Stream.mergeAll(
        [
          SubscriptionRef.changes(session.own).pipe(Stream.map(reconcile)),
          Stream.fromQueue(actions),
          Stream.tick("5 seconds").pipe(Stream.map(() => tick)),
        ],
        { concurrency: "unbounded" },
      ).pipe(Stream.runForEach((action) => Effect.andThen(action, syncBuffers)));
    },
    (effect) =>
      effect.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            current = null;
            playing = false;
            return stopAudio;
          }),
        ),
      ),
  );

  // The track of `entryId`, when this device plays it
  const trackOf = (entryId: EntryId) => (current === entryId ? track : null);

  return {
    volume: Effect.sync(() => volume),
    /** The audio position, `null` when this device does not play `entryId` */
    position: (entryId: EntryId) => trackOf(entryId)?.position() ?? null,
    /** Some providers give no duration before the download ends */
    durationMs: (entryId: EntryId) => trackOf(entryId)?.durationMs() ?? null,
    /** The response that plays `entryId`, for the visualizer */
    tap: (entryId: EntryId) => trackOf(entryId)?.tap() ?? null,
    /** For example `FLAC 24/96`, `null` when this device does not play `entryId` */
    quality: (entryId: EntryId) => trackOf(entryId)?.quality ?? null,
    /** Follows the session until it is interrupted */
    run,
  };
});

/** Plays the session on this device while the device is its output */
export class Engine extends Context.Service<
  Engine,
  Effect.Success<ReturnType<typeof makeEngine>>
>()("@dyad/cli/Engine") {}

export const engineLayer = (options: Parameters<typeof makeEngine>[0]) =>
  Layer.effect(Engine, makeEngine(options));
