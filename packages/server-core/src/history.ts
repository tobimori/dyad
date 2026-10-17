import { playEvent } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal } from "@dyad/domain";
import type { PlayContext } from "@dyad/domain";
import { Crypto, Effect } from "effect";

export const recordPlay = (play: {
  readonly sourceId: string;
  readonly startedAt: number;
  readonly playedMs: number;
  readonly completed: boolean;
  readonly context: typeof PlayContext.Type;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const principal = yield* CurrentPrincipal;
    const id = yield* crypto.randomUUIDv7().pipe(Effect.orDie);

    yield* db.insert(playEvent).values({
      id,
      userId: principal.userId,
      deviceId: principal.deviceId,
      ...play,
    });
  });
