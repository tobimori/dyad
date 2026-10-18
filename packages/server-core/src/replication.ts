import {
  catalogAssertion,
  entityMerge,
  libraryItem,
  playEvent,
  playlist,
  playlistEntry,
  recording,
  source,
  sourceVariant,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import { PeerCursor, PeerRow } from "@dyad/domain";
import type { CatalogInputRow, SyncRow } from "@dyad/domain";
import { HlcClock, mergeCatalogRow, mergeRow } from "@dyad/sync";
import { and, asc, eq, gt, gte, inArray, or } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import { Data, Effect, Option, Schema } from "effect";

import { projectRecordings } from "./assertions.ts";
import { isrcRecordingId } from "./ids.ts";
import { resolveRoots } from "./matching.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";
import { deriveTracklists } from "./tracklists.ts";

class PeerTable extends Data.Class<{
  readonly table: PeerRow["table"];
  readonly rows: SQLiteTable;
  readonly id: SQLiteColumn;
  readonly changeSeq: SQLiteColumn;
}> {}

const peerTable = (
  table: PeerRow["table"],
  rows: SQLiteTable & { id: SQLiteColumn; changeSeq: SQLiteColumn },
) => new PeerTable({ table, rows, id: rows.id, changeSeq: rows.changeSeq });

// Server replicas exchange every row of these tables. Canonical rows are derived on each replica.
const peerTables = {
  catalog_assertion: peerTable("catalog_assertion", catalogAssertion),
  entity_merge: peerTable("entity_merge", entityMerge),
  library_item: peerTable("library_item", libraryItem),
  play_event: peerTable("play_event", playEvent),
  playlist: peerTable("playlist", playlist),
  playlist_entry: peerTable("playlist_entry", playlistEntry),
  source: peerTable("source", source),
  source_variant: peerTable("source_variant", sourceVariant),
} satisfies Record<PeerRow["table"], PeerTable>;

// Rows sort by `(change_seq, table, id)`. `rowKey` is `<table>:<id>`.
const afterCursor = (table: PeerTable, cursor: PeerCursor) => {
  if (cursor.rowKey === null) return gt(table.changeSeq, cursor.changeSeq);

  const separator = cursor.rowKey.indexOf(":");
  const name = cursor.rowKey.slice(0, separator);
  if (table.table < name) return gt(table.changeSeq, cursor.changeSeq);
  if (table.table > name) return gte(table.changeSeq, cursor.changeSeq);
  return or(
    gt(table.changeSeq, cursor.changeSeq),
    and(eq(table.changeSeq, cursor.changeSeq), gt(table.id, cursor.rowKey.slice(separator + 1))),
  );
};

/**
 * The rows of all replicated tables after `cursor`, at most `limit`. A page can end inside the rows
 * of one write; the receiver derives after each page.
 */
export const readChanges = (cursor: PeerCursor, limit: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const tables = yield* Effect.forEach(Object.values(peerTables), (table) =>
      Effect.gen(function* () {
        const rows = yield* db
          .select()
          .from(table.rows)
          .where(afterCursor(table, cursor))
          .orderBy(asc(table.changeSeq), asc(table.id))
          .limit(limit + 1);

        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(PeerRow)({ ...row, table: table.table }).pipe(
            Effect.orDie,
            Effect.map((decoded) => ({
              // SAFETY: each replicated table has the integer column `change_seq`
              changeSeq: row["changeSeq"] as number,
              key: `${table.table}:${decoded.id}`,
              row: decoded,
            })),
          ),
        );
      }),
    );

    const sorted = tables
      .flat()
      .toSorted((a, b) => a.changeSeq - b.changeSeq || (a.key < b.key ? -1 : 1));
    const page = sorted.slice(0, limit);
    const last = page.at(-1);
    return {
      rows: page.map((entry) => entry.row),
      cursor:
        last === undefined
          ? cursor
          : new PeerCursor({ changeSeq: last.changeSeq, rowKey: last.key }),
      more: sorted.length > limit,
    };
  });

const readPeerRow = (table: PeerRow["table"], id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const peer = peerTables[table];
    const [row] = yield* db.select().from(peer.rows).where(eq(peer.id, id));
    if (row === undefined) return undefined;
    return yield* Schema.decodeUnknownEffect(PeerRow)({ ...row, table }).pipe(Effect.orDie);
  });

const writePeerRow = (row: PeerRow, changeSeq: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const peer = peerTables[row.table];
    const { table: _, ...values } = row;
    yield* db
      .insert(peer.rows)
      .values({ ...values, changeSeq })
      .onConflictDoUpdate({ target: peer.id, set: { ...values, changeSeq } });
  });

// RETURN TYPE: the predicate narrows the union for `mergeRow`
const isSyncRow = (row: PeerRow): row is SyncRow =>
  row.table === "library_item" ||
  row.table === "play_event" ||
  row.table === "playlist" ||
  row.table === "playlist_entry";

const IsrcEvidence = Schema.Struct({ isrc: Schema.String });

/**
 * Derives the canonical rows of the catalog input that changed. The writer of an assertion runs
 * matching; a receiver only follows the merges that arrive, so it never writes a decision that it
 * made from a part of the input.
 */
const deriveCatalog = (rows: ReadonlyArray<CatalogInputRow>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (rows.length === 0) return;

    // A recording exists when a source binds to it or an edge points to it, as on the writer
    const created: Array<string> = [];
    const ensure = (id: string, origin: "local" | "provider" | "isrc" | "musicbrainz") =>
      db
        .insert(recording)
        .values({ id, origin, policyVersion: 1, revision: 0 })
        .onConflictDoNothing()
        .returning({ id: recording.id })
        .pipe(Effect.map((inserted) => created.push(...inserted.map((row) => row.id))));

    const variantSources = rows.flatMap((row) =>
      row.table === "source_variant" ? [row.sourceId] : [],
    );
    const sources = [
      ...rows.flatMap((row) => (row.table === "source" ? [row] : [])),
      ...(variantSources.length === 0
        ? []
        : yield* db.select().from(source).where(inArray(source.id, variantSources))),
    ];
    for (const row of sources) {
      if (row.recordingId !== null) {
        yield* ensure(row.recordingId, row.provider === "local" ? "local" : "provider");
      }
    }

    const merges = rows.flatMap((row) =>
      row.table === "entity_merge" && row.entityType === "recording" ? [row] : [],
    );
    for (const merge of merges) {
      if (merge.origin !== "system" || merge.decision !== "merge") continue;
      const evidence = Schema.decodeUnknownOption(IsrcEvidence)(merge.evidence);
      const isrcTarget = Option.isSome(evidence)
        ? yield* isrcRecordingId(evidence.value.isrc)
        : undefined;
      yield* ensure(merge.intoId, merge.intoId === isrcTarget ? "isrc" : "musicbrainz");
    }

    const boundIds = sources.flatMap((row) => row.recordingId ?? []);
    const assertedIds = rows.flatMap((row) =>
      row.table === "catalog_assertion" && row.entityType === "recording" ? [row.entityId] : [],
    );
    const movedFrom = [...merges.map((merge) => merge.fromId), ...created];
    const resolved = movedFrom.length === 0 ? [] : [...(yield* resolveRoots(movedFrom))];

    const changed = [...new Set([...boundIds, ...assertedIds, ...merges.map((row) => row.intoId)])];
    const roots = yield* db
      .select({ root: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, changed));
    yield* projectRecordings([...changed, ...resolved, ...roots.flatMap((row) => row.root ?? [])]);
    // A changed source or variant changes the group of its recording
    yield* touchGroups(boundIds);

    const tracklists = rows.flatMap((row) =>
      row.table === "catalog_assertion" && row.entityType === "source" && row.field === "tracklist"
        ? [row.entityId]
        : [],
    );
    if (tracklists.length > 0) yield* deriveTracklists(tracklists);
  });

/**
 * Merges rows from another server replica, then derives the canonical rows. A row that changes
 * gets a `change_seq` of this replica, so that its other peers receive it; an unchanged row writes
 * nothing, so rows do not circulate. Run it in a transaction.
 */
export const mergePeerRows = (rows: ReadonlyArray<PeerRow>) =>
  Effect.gen(function* () {
    const clock = yield* HlcClock;
    const changeSeq = yield* Effect.cached(nextChangeSeq);
    const changed: Array<PeerRow> = [];

    for (const row of rows) {
      if (row.table !== "play_event" && row.hlc !== "") yield* clock.receive(row.hlc);

      const current = yield* readPeerRow(row.table, row.id);
      const merged: Option.Option<PeerRow> = isSyncRow(row)
        ? mergeRow(current !== undefined && isSyncRow(current) ? current : undefined, row)
        : mergeCatalogRow(current !== undefined && !isSyncRow(current) ? current : undefined, row);
      if (Option.isNone(merged)) continue;

      yield* writePeerRow(merged.value, yield* changeSeq);
      changed.push(merged.value);
    }

    yield* deriveCatalog(changed.flatMap((row) => (isSyncRow(row) ? [] : [row])));
    return changed.length;
  });
