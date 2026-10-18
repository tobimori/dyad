import {
  artist,
  artistCreditName,
  libraryItem,
  libraryRemoteTrack,
  playEvent,
  playlist,
  playlistEntry,
  recording,
  source,
  sourceKey,
  sourcePreference,
  sourceSegment,
  sourceVariant,
} from "@dyad/db/client";
import { SyncRow } from "@dyad/domain";
import type { CatalogGroup, SyncChange, SyncScope, SyncTable } from "@dyad/domain";
import { applyChange, changeTarget, mergeRow } from "@dyad/sync";
import { eq, inArray, or } from "drizzle-orm";
import type { SQLiteColumn, SQLiteInsertValue, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Array as Arr, Data, Effect, Option, Schema } from "effect";

import { ClientDatabase } from "./database.ts";

// Below the SQLite limit of 32766 parameters for the widest table
const chunkSize = 500;

class SyncedTable extends Data.Class<{
  readonly name: SyncTable;
  readonly rows: SQLiteTable;
  readonly id: SQLiteColumn;
  /** Holds the ID in the scope name */
  readonly scopeColumn: SQLiteColumn;
}> {}

const syncedTables = {
  library_item: new SyncedTable({
    name: "library_item",
    rows: libraryItem,
    id: libraryItem.id,
    scopeColumn: libraryItem.userId,
  }),
  play_event: new SyncedTable({
    name: "play_event",
    rows: playEvent,
    id: playEvent.id,
    scopeColumn: playEvent.userId,
  }),
  playlist: new SyncedTable({
    name: "playlist",
    rows: playlist,
    id: playlist.id,
    scopeColumn: playlist.id,
  }),
  playlist_entry: new SyncedTable({
    name: "playlist_entry",
    rows: playlistEntry,
    id: playlistEntry.id,
    scopeColumn: playlistEntry.playlistId,
  }),
  source_preference: new SyncedTable({
    name: "source_preference",
    rows: sourcePreference,
    id: sourcePreference.id,
    scopeColumn: sourcePreference.userId,
  }),
} satisfies Record<SyncTable, SyncedTable>;

const insertAll = <T extends SQLiteTable>(table: T, values: ReadonlyArray<SQLiteInsertValue<T>>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    for (const chunk of Arr.chunksOf(values, chunkSize)) {
      yield* db.insert(table).values([...chunk]);
    }
  });

const deleteWhereIn = (table: SQLiteTable, column: SQLiteColumn, ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    for (const chunk of Arr.chunksOf(ids, chunkSize)) {
      yield* db.delete(table).where(inArray(column, [...chunk]));
    }
  });

const columnsOf = (row: SyncRow) => {
  const { table: _, ...values } = row;
  return values;
};

/** Merges rows from the server or from own mutations. Returns the tables that changed. */
export const mergeRows = (rows: ReadonlyArray<SyncRow>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const changedTables = new Set<SyncTable>();

    for (const table of Object.values(syncedTables)) {
      const incoming = rows.filter((row) => row.table === table.name);
      if (incoming.length === 0) continue;

      const ids = [...new Set(incoming.map((row) => row.id))];
      const stored = yield* Effect.forEach(Arr.chunksOf(ids, chunkSize), (chunk) =>
        db
          .select()
          .from(table.rows)
          .where(inArray(table.id, [...chunk])),
      );
      const current = new Map<string, SyncRow>();
      for (const row of stored.flat()) {
        const decoded = yield* Schema.decodeUnknownEffect(SyncRow)({ ...row, table: table.name });
        current.set(decoded.id, decoded);
      }

      const changed = new Map<string, SyncRow>();
      for (const row of incoming) {
        const merged = mergeRow(current.get(row.id), row);
        if (Option.isNone(merged)) continue;
        current.set(row.id, merged.value);
        changed.set(row.id, merged.value);
      }
      if (changed.size === 0) continue;

      yield* deleteWhereIn(table.rows, table.id, [...changed.keys()]);
      yield* insertAll(table.rows, [...changed.values()].map(columnsOf));
      changedTables.add(table.name);
    }
    return changedTables;
  }).pipe(Effect.orDie);

/** Applies own changes in order. Returns the tables that changed. */
export const applyChanges = (changes: ReadonlyArray<SyncChange>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const changedTables = new Set<SyncTable>();

    for (const change of changes) {
      const { table, id } = changeTarget(change);
      const synced = syncedTables[table];
      const [stored] = yield* db.select().from(synced.rows).where(eq(synced.id, id));
      const current =
        stored === undefined
          ? undefined
          : yield* Schema.decodeUnknownEffect(SyncRow)({ ...stored, table });

      const next = applyChange(current, change);
      if (Option.isNone(next)) continue;
      yield* deleteWhereIn(synced.rows, synced.id, [id]);
      yield* insertAll(synced.rows, [columnsOf(next.value)]);
      changedTables.add(table);
    }
    return changedTables;
  }).pipe(Effect.orDie);

/** Replaces a row with the server's row, or deletes it when the server has none */
export const replaceRow = (name: SyncTable, id: string, row: SyncRow | null) =>
  Effect.gen(function* () {
    const table = syncedTables[name];
    yield* deleteWhereIn(table.rows, table.id, [id]);
    if (row !== null) yield* insertAll(table.rows, [columnsOf(row)]);
  }).pipe(Effect.orDie);

/** Deletes the rows of a scope that the user can no longer read */
export const deleteScope = (scope: SyncScope) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const [kind, id] = scope.split(":");
    const tables =
      kind === "user"
        ? [syncedTables.library_item, syncedTables.play_event, syncedTables.source_preference]
        : [syncedTables.playlist, syncedTables.playlist_entry];
    for (const table of tables) {
      yield* db.delete(table.rows).where(eq(table.scopeColumn, id ?? ""));
    }
    return tables.map((table) => table.name);
  }).pipe(Effect.orDie);

/**
 * Replaces the local rows of a merge group, so that a merge or a split never leaves mixed
 * membership. Recordings that left the group lose their sources until their own group comes.
 */
export const replaceGroup = (group: CatalogGroup) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;

    const members = yield* db
      .select({ id: recording.id })
      .from(recording)
      .where(or(eq(recording.id, group.rootId), eq(recording.mergedIntoId, group.rootId)));
    const recordingIds = [
      ...new Set([...members.map((row) => row.id), ...group.recordings.map((row) => row.id)]),
    ];
    const sources = yield* Effect.forEach(Arr.chunksOf(recordingIds, chunkSize), (chunk) =>
      db
        .select({ id: source.id })
        .from(source)
        .where(inArray(source.recordingId, [...chunk])),
    );
    const sourceIds = [
      ...new Set([...sources.flat().map((row) => row.id), ...group.sources.map((row) => row.id)]),
    ];

    yield* deleteWhereIn(sourceVariant, sourceVariant.sourceId, sourceIds);
    yield* deleteWhereIn(sourceSegment, sourceSegment.sourceId, sourceIds);
    yield* deleteWhereIn(sourceKey, sourceKey.sourceId, sourceIds);
    yield* deleteWhereIn(source, source.id, sourceIds);
    yield* deleteWhereIn(libraryRemoteTrack, libraryRemoteTrack.recordingId, recordingIds);
    yield* deleteWhereIn(recording, recording.id, recordingIds);

    yield* insertAll(recording, group.recordings);
    yield* insertAll(source, group.sources);
    yield* insertAll(sourceVariant, group.variants);
    yield* insertAll(sourceSegment, group.segments);
    yield* insertAll(sourceKey, group.sourceKeys);
    yield* insertAll(libraryRemoteTrack, group.remoteTracks);

    // Credits are content-addressed and artists are shared between groups, so they are not deleted
    for (const chunk of Arr.chunksOf(group.creditNames, chunkSize)) {
      yield* db
        .insert(artistCreditName)
        .values([...chunk])
        .onConflictDoNothing();
    }
    for (const row of group.artists) {
      yield* db.insert(artist).values(row).onConflictDoUpdate({ target: artist.id, set: row });
    }
  }).pipe(Effect.orDie);

/** Replaces the provider library data of recordings that have no group */
export const replaceMissingRemoteTracks = (
  recordingIds: ReadonlyArray<string>,
  rows: ReadonlyArray<typeof libraryRemoteTrack.$inferInsert>,
) =>
  Effect.gen(function* () {
    yield* deleteWhereIn(libraryRemoteTrack, libraryRemoteTrack.recordingId, recordingIds);
    yield* insertAll(libraryRemoteTrack, rows);
  }).pipe(Effect.orDie);

/** Tables of the catalog groups */
export const catalogTables = [
  "artist",
  "artist_credit_name",
  "recording",
  "source",
  "source_variant",
  "source_segment",
  "source_key",
  "library_remote_track",
] as const;
