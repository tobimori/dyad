import { playbackSession } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { EntryId, OutputId, Playback, QueueEntry, RepeatMode, UserId } from "@dyad/domain";
import { Clock, Data, Effect, Schema } from "effect";

/** The part of a session that survives a restart */
export class SessionState extends Data.Class<{
  readonly entries: ReadonlyArray<QueueEntry>;
  readonly nextEntryId: number;
  readonly queueVersion: number;
  readonly playback: Playback;
}> {}

const SavedEntries = Schema.Array(QueueEntry);

class SavedPlayback extends Schema.Class<SavedPlayback>("SavedPlayback")({
  state: Schema.Literals(["stopped", "paused", "playing"]),
  entryId: Schema.NullOr(EntryId),
  positionMs: Schema.Number,
  outputId: Schema.NullOr(OutputId),
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
}) {}

/**
 * The saved sessions. Nothing plays after a restart, so a session loads paused. A session that does
 * not decode, for example after a format change, starts empty.
 */
export const loadSessions = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db.select().from(playbackSession);

  return yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const entries = yield* Schema.decodeUnknownEffect(SavedEntries)(row.entries);
      const saved = yield* Schema.decodeUnknownEffect(SavedPlayback)(row.playback);
      const state = new SessionState({
        // Unplayable marks are for one pass, and the next start can work
        entries: entries.map((entry) => new QueueEntry({ ...entry, unplayable: false })),
        nextEntryId: row.nextEntryId,
        queueVersion: row.queueVersion,
        playback: new Playback({
          ...saved,
          state: saved.state === "stopped" ? "stopped" : "paused",
          at: 0,
          rate: 0,
          revision: row.revision,
          lost: false,
        }),
      });
      return [[UserId.make(row.userId), state] as const];
    }).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning("Cannot load a playback session", error).pipe(Effect.as([])),
      ),
    ),
  ).pipe(Effect.map((sessions) => sessions.flat()));
});

export const saveSession = (userId: UserId, state: SessionState) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const playback = state.playback;
    const row = {
      userId,
      entries: yield* Schema.encodeEffect(SavedEntries)(state.entries),
      nextEntryId: state.nextEntryId,
      queueVersion: state.queueVersion,
      revision: playback.revision,
      playback: yield* Schema.encodeEffect(SavedPlayback)(
        new SavedPlayback({
          state: playback.state,
          entryId: playback.entryId,
          positionMs: playback.positionMs,
          outputId: playback.outputId,
          shuffle: playback.shuffle,
          repeat: playback.repeat,
        }),
      ),
      updatedAt: yield* Clock.currentTimeMillis,
    };
    yield* db
      .insert(playbackSession)
      .values(row)
      .onConflictDoUpdate({ target: playbackSession.userId, set: row });
  });
