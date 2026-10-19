import { currentEntryOf, positionOf } from "@dyad/client-runtime";
import type { SessionClient } from "@dyad/client-runtime";
import { SessionCommand, skipSeekTarget } from "@dyad/domain";
import type { SourceSegment } from "@dyad/domain";
import { Clock, Effect, SubscriptionRef } from "effect";

import type { Engine } from "./engine.ts";

/** The transport commands for client plugins, with the same rules as the keys of `usePlayer` */
export const pluginTransport = (
  session: typeof SessionClient.Service,
  engine: typeof Engine.Service | null,
  segmentsOf: (sourceId: string) => ReadonlyArray<SourceSegment>,
) => {
  const send = Effect.fn(function* (command: typeof SessionCommand.Type) {
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
      sourceId: entry.source.id,
      positionMs: engine?.position(entry.id) ?? positionOf(view, now),
      durationMs: entry.source.durationMs ?? engine?.durationMs(entry.id) ?? null,
    };
  });

  const seekTo = Effect.fn(function* (ms: number) {
    const entry = yield* current;
    if (entry === undefined) return;
    const end = entry.durationMs;
    const positionMs = Math.max(0, end === null ? ms : Math.min(ms, end));
    yield* send(SessionCommand.cases.Seek.make({ entryId: entry.id, positionMs }));
  });

  const skip = Effect.fn(function* (direction: 1 | -1) {
    const entry = yield* current;
    if (entry === undefined) return;
    const target = skipSeekTarget(segmentsOf(entry.sourceId), entry.positionMs, direction);
    if (target !== undefined) return yield* seekTo(target);
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
