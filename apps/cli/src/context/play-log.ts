import { OfflinePlay } from "@dyad/domain";
import { Effect, FileSystem, Path, Schema, Semaphore } from "effect";
import envPaths from "env-paths";

// `recordPlays` takes at most this many plays, so the log drops the oldest
const maxPlays = 1000;

// The plays of offline time for each server origin, until the server has them
const PlayLogs = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Array(OfflinePlay)));

const noLogs: typeof PlayLogs.Type = {};

/** A file, so that plays of offline time survive a quit before the server comes back */
export const openPlayLog = (origin: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = path.join(envPaths("dyad", { suffix: "" }).data, "plays.json");
    const writing = yield* Semaphore.make(1);

    // A broken file gives an empty log. The next write replaces it.
    const read = Effect.gen(function* () {
      if (!(yield* fs.exists(file))) return noLogs;
      return yield* Schema.decodeEffect(PlayLogs)(yield* fs.readFileString(file));
    }).pipe(Effect.orElseSucceed(() => noLogs));

    const change = (update: (plays: ReadonlyArray<OfflinePlay>) => ReadonlyArray<OfflinePlay>) =>
      writing.withPermits(1)(
        Effect.gen(function* () {
          const logs = yield* read;
          const plays = update(logs[origin] ?? []).slice(-maxPlays);
          yield* fs.makeDirectory(path.dirname(file), { recursive: true });
          yield* fs.writeFileString(
            file,
            yield* Schema.encodeEffect(PlayLogs)({ ...logs, [origin]: plays }),
          );
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("Cannot save the play log", cause))),
      );

    return {
      pending: Effect.map(read, (logs) => logs[origin] ?? []),
      add: (play: OfflinePlay) => change((plays) => [...plays, play]),
      remove: (sent: ReadonlyArray<OfflinePlay>) =>
        change((plays) => plays.filter((play) => !sent.some((done) => done.id === play.id))),
    };
  });
