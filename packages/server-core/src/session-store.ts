import { playbackSession } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { EntryId, OutputId, Playback, QueueEntry, RepeatMode } from "@dyad/domain";
import { eq } from "drizzle-orm";
import { Clock, Data, Effect, Option, Schema } from "effect";

/** The part of a room that survives a restart */
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
  group: Schema.Array(OutputId).pipe(Schema.withDecodingDefaultKey(Effect.succeed([]))),
  shuffle: Schema.Boolean,
  repeat: RepeatMode,
}) {}

/**
 * The saved rooms. Nothing plays after a restart, so they load paused. A room that does not decode,
 * for example after a format change, starts empty.
 */
export const loadSessions = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db.select().from(playbackSession);
  const loaded = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const entries = yield* Schema.decodeUnknownEffect(SavedEntries)(row.entries);
      const saved = yield* Schema.decodeUnknownEffect(SavedPlayback)(row.playback);
      return Option.some({
        room: OutputId.make(row.room),
        name: row.name,
        state: new SessionState({
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
        }),
      });
    }).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.logWarning("Cannot load a room", error).pipe(Effect.as(Option.none())),
      ),
    ),
  );
  return loaded.flatMap(Option.toArray);
});

export const saveSession = Effect.fn("saveSession")(function* (
  room: OutputId,
  name: string,
  state: SessionState,
) {
  const db = yield* Database;
  const playback = state.playback;
  const row = {
    name,
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
        group: playback.group,
        shuffle: playback.shuffle,
        repeat: playback.repeat,
      }),
    ),
    updatedAt: yield* Clock.currentTimeMillis,
  };
  yield* db
    .insert(playbackSession)
    .values({ room, ...row })
    .onConflictDoUpdate({ target: playbackSession.room, set: row });
});

export const deleteSession = Effect.fn("deleteSession")(function* (room: OutputId) {
  yield* (yield* Database).delete(playbackSession).where(eq(playbackSession.room, room));
});
