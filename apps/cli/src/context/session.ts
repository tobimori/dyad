import type { SessionClient } from "@dyad/client-runtime";
import { PlayContext, RepeatMode, SessionCommand, SourceSummary } from "@dyad/domain";
import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import envPaths from "env-paths";

class SavedEntry extends Schema.Class<SavedEntry>("SavedEntry")({
  source: SourceSummary,
  context: PlayContext,
}) {}

// The player state that CLI versions before server sessions kept for each server
class SavedSession extends Schema.Class<SavedSession>("SavedSession")({
  entries: Schema.Array(SavedEntry),
  current: Schema.NullOr(Schema.Int),
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
  volume: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
}) {}

const SavedSessions = Schema.fromJsonString(Schema.Record(Schema.String, SavedSession));

const sessionFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(envPaths("dyad", { suffix: "" }).config, "sessions.json");
});

const noSessions: typeof SavedSessions.Type = {};

// A broken file or a file of another version gives nothing to import
const readSessions = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* sessionFile;
  const exists = yield* fs.exists(file);
  if (!exists) return noSessions;

  const text = yield* fs.readFileString(file);
  return yield* Schema.decodeEffect(SavedSessions)(text);
}).pipe(Effect.orElseSucceed(() => noSessions));

/** The volume of the old session of `origin`, for the first start after the update */
export const savedVolume = (origin: string) =>
  Effect.map(readSessions, (sessions) =>
    Option.map(Option.fromUndefinedOr(sessions[origin]), (saved) => saved.volume),
  );

/**
 * Moves the old session of `origin` to the server once, then removes it from the file. A server
 * session that already has entries wins. Entries before the current one are not moved.
 */
export const importSavedSession = (origin: string, session: typeof SessionClient.Service) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const file = yield* sessionFile;
    const sessions = yield* readSessions;
    const saved = sessions[origin];
    if (saved === undefined) return;

    const view = yield* SubscriptionRef.changes(session.view).pipe(
      Stream.filter((current) => current.connected),
      Stream.runHead,
    );
    const upcoming = saved.entries.slice(saved.current ?? 0);
    const empty = Option.exists(view, (current) => current.entries.length === 0);
    if (empty && Arr.isReadonlyArrayNonEmpty(upcoming)) {
      // One command has one context, so each run of entries with the same context is one command
      const runs = Arr.groupWith(upcoming, (left, right) => left.context === right.context);
      for (const run of runs) {
        const ids = Arr.map(run, (entry) => entry.source.id);
        for (const sourceIds of Arr.chunksOf(ids, 10_000)) {
          const enqueue = SessionCommand.cases.Enqueue.make({
            sourceIds,
            context: run[0].context,
            after: "end",
          });
          // Sources that the server no longer has give `nothing_to_play`
          yield* session
            .send(enqueue)
            .pipe(Effect.catchTag("SessionCommandFailed", () => Effect.void));
        }
      }
      if (saved.repeat !== "off") {
        yield* session.send(SessionCommand.cases.SetRepeat.make({ mode: saved.repeat }));
      }
    }

    const others = Object.fromEntries(Object.entries(sessions).filter(([key]) => key !== origin));
    if (Object.keys(others).length === 0) {
      yield* fs.remove(file);
      return;
    }
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(SavedSessions)(others));
  });
