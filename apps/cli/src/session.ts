import { PlayContext, SourceSummary } from "@dyad/domain";
import { Effect, FileSystem, Option, Path, Schema } from "effect";
import envPaths from "env-paths";

import { PlayQueue, RepeatMode, queueEntry } from "./queue.ts";

class SavedEntry extends Schema.Class<SavedEntry>("SavedEntry")({
  source: SourceSummary,
  context: PlayContext,
}) {}

/** The player state that the CLI restores on the next start */
export class SavedSession extends Schema.Class<SavedSession>("SavedSession")({
  entries: Schema.Array(SavedEntry),
  current: Schema.NullOr(Schema.Int),
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
}) {}

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

export const sessionOf = (queue: PlayQueue, volume: number) =>
  new SavedSession({
    entries: queue.entries.map(
      (entry) => new SavedEntry({ source: entry.source, context: entry.context }),
    ),
    current: queue.current,
    shuffle: queue.shuffle,
    repeat: queue.repeat,
    volume,
  });

export const queueOf = (session: SavedSession) =>
  new PlayQueue({
    entries: session.entries.map((entry) => queueEntry(entry.source, entry.context)),
    current: session.current,
    shuffle: session.shuffle,
    repeat: session.repeat,
  });
