import { ServerConnection, deviceOutputId, positionOf, titleOf } from "@dyad/client-runtime";
import type { SessionClient, SessionView } from "@dyad/client-runtime";
import { PlaybackUnavailable, PlayerResume, nextEntry } from "@dyad/domain";
import type { EntryId, QueueEntry } from "@dyad/domain";
import type { Audio } from "@opentui/core";
import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Layer,
  Option,
  Predicate,
  Queue,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { HttpClient } from "effect/http";

import { describeFailure } from "../log.ts";
import { openTrack } from "./player.ts";
import type { Track } from "./player.ts";

// A smaller difference between the session and the audio is report jitter, not a seek
const seekThresholdMs = 1000;

// The transport of the session that the engine followed last
class Followed extends Data.Class<{
  readonly generation: number;
  readonly revision: number;
  readonly entryId: EntryId | null;
}> {}

const nothingFollowed = new Followed({ generation: -1, revision: -1, entryId: null });

// The text stays until the next entry, so that the user can read why nothing plays
const failureText = (error: Option.Option<unknown>, title: string) => {
  if (Option.isNone(error) || !Schema.is(PlaybackUnavailable)(error.value)) {
    return `Cannot play ${title}`;
  }

  if (error.value.reason === "account_required") return `Link an account to play ${title}`;
  if (error.value.reason === "not_found") return `${title} is no longer available`;
  return `Cannot play ${title}`;
};

const makeEngine = (options: {
  readonly audio: Audio;
  readonly serverUrl: string;
  readonly volume: number;
  readonly saveVolume: (volume: number) => Effect.Effect<void>;
}) =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const services = yield* Effect.context<ServerConnection | HttpClient.HttpClient>();
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

    const stopAudio = Effect.suspend(() => {
      const closing = trackScope;
      positionMs = positionNow();
      track = null;
      trackScope = null;
      token += 1;
      return closing === null ? Effect.void : Scope.close(closing, Exit.void);
    });

    const run = (session: typeof SessionClient.Service, onFailure: (text: string | null) => void) =>
      Effect.gen(function* () {
        const actions = yield* Queue.unbounded<Effect.Effect<void>>();
        const latest = SubscriptionRef.get(session.view);

        const report = (
          view: SessionView,
          fields: {
            readonly entryId: EntryId;
            readonly state: "playing" | "paused" | "buffering" | "ended" | "failed";
            readonly positionMs: number;
            readonly failure: PlaybackUnavailable["reason"] | null;
          },
        ) =>
          Effect.gen(function* () {
            if (!view.connected) return;

            const revision = followed.revision;
            // The server ignores a report of a revision that it does not know yet
            if (view.confirmed.revision === revision) reportedRevision = revision;
            yield* connection
              .reportPlayback({ ...fields, generation: view.generation, revision, volume })
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

        const started = (opened: number, loaded: Track) =>
          Effect.gen(function* () {
            if (opened !== token) return;
            track = loaded;
            yield* reportState(yield* latest);
          });

        const failed = (opened: number, entry: QueueEntry, cause: Cause.Cause<unknown>) =>
          Effect.gen(function* () {
            if (opened !== token) return;
            yield* Effect.logWarning("Cannot play", describeFailure(cause)).pipe(
              Effect.annotateLogs({ sourceId: entry.source.id, provider: entry.source.provider }),
            );
            yield* stopAudio;
            playing = false;

            // Without the server, the entry did not fail. It waits for the connection.
            const view = yield* latest;
            const error = Cause.findErrorOption(cause);
            if (!view.connected || Option.exists(error, Predicate.isTagged("RpcClientError"))) {
              return;
            }

            onFailure(failureText(error, titleOf(entry.source)));
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

        const open = (entry: QueueEntry, startMs: number) =>
          Effect.gen(function* () {
            yield* stopAudio;
            const opened = token;
            const scope = yield* Scope.make();
            current = entry.id;
            positionMs = startMs;
            trackScope = scope;
            playing = true;
            audio.start();
            onFailure(null);

            const play = Effect.gen(function* () {
              const loaded = yield* openTrack(audio, options.serverUrl, entry.source.id, startMs);
              yield* Queue.offer(actions, started(opened, loaded));
              yield* loaded.ended;
            });

            yield* play.pipe(
              Effect.matchCauseEffect({
                onSuccess: () => Queue.offer(actions, ended(opened)),
                onFailure: (cause) =>
                  Cause.hasInterruptsOnly(cause)
                    ? Effect.void
                    : Queue.offer(actions, failed(opened, entry, cause)),
              }),
              Scope.provide(scope),
              Effect.provideContext(services),
              Effect.forkIn(scope),
            );
          });

        // The engine starts the next entry itself, then reports the end, so that the gap stays
        // short. The server then makes the next entry current.
        // RETURN TYPE: `ended` and `open` refer to each other, so TypeScript cannot infer both
        const ended = (opened: number): Effect.Effect<void> =>
          Effect.gen(function* () {
            const entryId = current;
            if (opened !== token || entryId === null) return;

            const view = yield* latest;
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

        const applyVolume = (view: SessionView) => {
          const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
          const output = view.outputs.find((candidate) => candidate.id === own);
          if (output?.volume == null || output.volume === volume) return Effect.void;

          volume = output.volume;
          audio.setMasterVolume(volume);
          return options.saveVolume(volume);
        };

        const reconcile = (view: SessionView) =>
          Effect.gen(function* () {
            yield* applyVolume(view);

            const playback = view.playback;
            const before = followed;
            followed = new Followed({
              generation: view.generation,
              revision: playback.revision,
              entryId: playback.entryId,
            });

            const mine =
              view.deviceId !== null &&
              playback.outputId === deviceOutputId(view.deviceId) &&
              !view.superseded;
            const entry = view.entries.find((candidate) => candidate.id === playback.entryId);
            if (!mine || playback.state === "stopped" || entry === undefined) {
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
            SubscriptionRef.changes(session.view).pipe(Stream.map(reconcile)),
            Stream.fromQueue(actions),
            Stream.tick("5 seconds").pipe(Stream.map(() => tick)),
          ],
          { concurrency: "unbounded" },
        ).pipe(Stream.runForEach((action) => action));
      }).pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            current = null;
            playing = false;
            return stopAudio;
          }),
        ),
      );

    // The track of `entryId`, when this device plays it
    const trackOf = (entryId: EntryId) => (current === entryId ? track : null);

    return {
      /** What the device plays, for `connectDevice` after the connection dropped */
      resume: Effect.sync(() => {
        if (current === null) return null;
        return new PlayerResume({
          revision: followed.revision,
          entryId: current,
          positionMs: positionNow(),
          state: playing && track !== null ? "playing" : "paused",
        });
      }),
      volume: Effect.sync(() => volume),
      /** The audio position, `null` when this device does not play `entryId` */
      position: (entryId: EntryId) => trackOf(entryId)?.position() ?? null,
      /** Some providers give no duration before the download ends */
      durationMs: (entryId: EntryId) => trackOf(entryId)?.durationMs() ?? null,
      /** The response that plays `entryId`, for the visualizer */
      tap: (entryId: EntryId) => trackOf(entryId)?.tap() ?? null,
      /** Follows the session until it is interrupted. `onFailure` gets `null` when an entry starts. */
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
