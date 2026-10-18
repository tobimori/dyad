import { currentEntryOf, isTransportCommand, positionOf } from "@dyad/client-runtime";
import type { SessionClient } from "@dyad/client-runtime";
import { SessionCommand } from "@dyad/domain";
import { Clock, Effect, SubscriptionRef } from "effect";

import type { Engine } from "./engine.ts";
import { restartAfterMs } from "./use-player.ts";

/** The transport commands for client plugins, with the same rules as the keys of `usePlayer` */
export const pluginTransport = (
  session: typeof SessionClient.Service,
  engine: typeof Engine.Service | null,
) => {
  const send = (command: typeof SessionCommand.Type) =>
    Effect.gen(function* () {
      const view = yield* SubscriptionRef.get(session.view);
      // Offline, only the device that plays can change its own audio
      if (!view.connected && isTransportCommand(command) && engine?.controlOffline(command)) {
        return;
      }
      yield* session
        .send(command)
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("The session refused a plugin command", cause),
          ),
        );
    });

  const current = Effect.gen(function* () {
    const view = yield* SubscriptionRef.get(session.view);
    const entry = currentEntryOf(view);
    if (entry === undefined) return undefined;

    const now = yield* Clock.currentTimeMillis;
    return {
      id: entry.id,
      positionMs: engine?.position(entry.id) ?? positionOf(view, now),
      durationMs: entry.source.durationMs ?? engine?.durationMs(entry.id) ?? null,
    };
  });

  const seekTo = (ms: number) =>
    Effect.gen(function* () {
      const entry = yield* current;
      if (entry === undefined) return;
      const end = entry.durationMs;
      const positionMs = Math.max(0, end === null ? ms : Math.min(ms, end));
      yield* send(SessionCommand.cases.Seek.make({ entryId: entry.id, positionMs }));
    });

  const skip = (direction: 1 | -1) =>
    Effect.gen(function* () {
      const entry = yield* current;
      if (entry === undefined) return;
      if (direction === -1 && entry.positionMs > restartAfterMs) return yield* seekTo(0);
      yield* send(SessionCommand.cases.Skip.make({ fromEntryId: entry.id, direction }));
    });

  return {
    play: send(SessionCommand.cases.Resume.make({})),
    pause: send(SessionCommand.cases.Pause.make({})),
    togglePause: Effect.gen(function* () {
      const view = yield* SubscriptionRef.get(session.view);
      yield* send(
        view.playback.state === "playing"
          ? SessionCommand.cases.Pause.make({})
          : SessionCommand.cases.Resume.make({}),
      );
    }),
    next: skip(1),
    previous: skip(-1),
    seekTo,
    seekBy: (offsetMs: number) =>
      Effect.gen(function* () {
        const entry = yield* current;
        if (entry !== undefined) yield* seekTo(entry.positionMs + offsetMs);
      }),
  };
};
