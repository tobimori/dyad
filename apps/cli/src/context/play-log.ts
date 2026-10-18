import type { Replica } from "@dyad/client-runtime";
import { PlayContext } from "@dyad/domain";
import { Effect, FileSystem, Path, Schema, Stream, SubscriptionRef } from "effect";
import envPaths from "env-paths";

// A play of offline time that CLI versions before the client replica kept in `plays.json`
class LoggedPlay extends Schema.Class<LoggedPlay>("LoggedPlay")({
  id: Schema.String,
  sourceId: Schema.String,
  context: PlayContext,
  startedAt: Schema.Number,
  playedMs: Schema.Number,
  completed: Schema.Boolean,
}) {}

// For each server origin
const PlayLogs = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(LoggedPlay)));

/**
 * Moves the plays of `origin` from `plays.json` into the mutation queue once, then removes them
 * from the file. A play that moves twice after a crash is still one row.
 */
export const movePlayLog = (origin: string, replica: typeof Replica.Service) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(envPaths("dyad", { suffix: "" }).data, "plays.json");
    if (!(yield* fs.exists(file))) return;

    const logs = yield* Schema.decodeEffect(PlayLogs)(yield* fs.readFileString(file));
    const plays = logs[origin];
    if (plays === undefined) return;

    // A replica gets its user and device at the first connection
    yield* SubscriptionRef.changes(replica.status).pipe(
      Stream.filter((status) => status === "live"),
      Stream.runHead,
    );
    yield* Effect.forEach(plays, replica.appendPlay, { discard: true });

    const others = Object.fromEntries(Object.entries(logs).filter(([key]) => key !== origin));
    if (Object.keys(others).length === 0) return yield* fs.remove(file);
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(PlayLogs)(others));
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Cannot move the play log", cause)));
