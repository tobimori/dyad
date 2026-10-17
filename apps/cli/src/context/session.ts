import { SavedSession } from "@dyad/client-runtime";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import envPaths from "env-paths";

// One session per server origin, because the entries are sources of that server
const Sessions = Schema.fromJsonString(Schema.Record(Schema.String, SavedSession));

const sessionFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(envPaths("dyad", { suffix: "" }).config, "sessions.json");
});

const readSessions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* sessionFile;
  const exists = yield* fs.exists(file);
  if (!exists) return {};

  const text = yield* fs.readFileString(file);
  return yield* Schema.decodeEffect(Sessions)(text);
});

/** A file from another CLI version or a broken file gives an empty player, not an error */
export const loadSession = (origin: string) =>
  readSessions.pipe(
    Effect.map((sessions) => Option.fromUndefinedOr(sessions[origin])),
    Effect.orElseSucceed(() => Option.none<SavedSession>()),
  );

export const saveSession = (origin: string, session: SavedSession) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* sessionFile;
    const sessions = yield* readSessions.pipe(Effect.orElseSucceed(() => ({})));

    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    const text = yield* Schema.encodeEffect(Sessions)({ ...sessions, [origin]: session });
    yield* fs.writeFileString(file, text);
  });
