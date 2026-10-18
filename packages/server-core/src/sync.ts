import {
  libraryItem,
  playEvent,
  playlist,
  playlistEntry,
  replica,
  replicaIdentity,
  syncRejection,
} from "@dyad/db";
import { Database, ReplicaDatabase, orDieOnDatabaseError } from "@dyad/db/node";
import {
  CurrentPrincipal,
  PlayEventRow,
  ReplicaId,
  ReplicaMismatch,
  ScopeCursor,
  SyncHint,
  SyncMutationResult,
  SyncPullResponse,
  SyncPushResponse,
  SyncRow,
  SyncScope,
  SyncTouchedRow,
  UpgradeRequired,
  WorkspaceId,
  syncProtocolVersion,
} from "@dyad/domain";
import type {
  SyncMutation,
  SyncPullRequest,
  SyncPushRequest,
  SyncTable,
  UserId,
} from "@dyad/domain";
import { mergeRow } from "@dyad/sync";
import { and, asc, eq, gt, gte, inArray, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";

import { readCatalog } from "./catalog-sync.ts";
import { nextChangeSeq } from "./sync-counter.ts";

const pageLimit = 1000;

const checkVersion = (protocolVersion: number) =>
  protocolVersion === syncProtocolVersion
    ? Effect.void
    : Effect.fail(new UpgradeRequired({ serverProtocolVersion: syncProtocolVersion }));

// Returns the last mutation that this server admitted or rejected for the replica
const bindReplica = (replicaId: ReplicaId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;

    const [row] = yield* db.select().from(replica).where(eq(replica.replicaId, replicaId));
    if (row !== undefined) {
      return row.deviceId === principal.deviceId
        ? row.lastMutationId
        : yield* new ReplicaMismatch();
    }

    yield* db.insert(replica).values({
      replicaId,
      userId: principal.userId,
      deviceId: principal.deviceId,
      createdAt: yield* Clock.currentTimeMillis,
    });
    return 0;
  });

// A table of a scope. `scopeColumn` holds the ID in the scope name.
class SyncSource extends Data.Class<{
  readonly table: SyncTable;
  readonly rows: SQLiteTable;
  readonly scopeColumn: SQLiteColumn;
  readonly changeSeq: SQLiteColumn;
  readonly id: SQLiteColumn;
}> {}

const sourcesOf = (scope: SyncScope) =>
  scope.startsWith("user:")
    ? [
        new SyncSource({
          table: "library_item",
          rows: libraryItem,
          scopeColumn: libraryItem.userId,
          changeSeq: libraryItem.changeSeq,
          id: libraryItem.id,
        }),
        new SyncSource({
          table: "play_event",
          rows: playEvent,
          scopeColumn: playEvent.userId,
          changeSeq: playEvent.changeSeq,
          id: playEvent.id,
        }),
      ]
    : [
        new SyncSource({
          table: "playlist",
          rows: playlist,
          scopeColumn: playlist.id,
          changeSeq: playlist.changeSeq,
          id: playlist.id,
        }),
        new SyncSource({
          table: "playlist_entry",
          rows: playlistEntry,
          scopeColumn: playlistEntry.playlistId,
          changeSeq: playlistEntry.changeSeq,
          id: playlistEntry.id,
        }),
      ];

// Rows of one scope sort by `(change_seq, table, id)`. `rowKey` is `<table>:<id>`.
const afterCursor = (source: SyncSource, cursor: ScopeCursor) => {
  if (cursor.rowKey === null) return gt(source.changeSeq, cursor.changeSeq);

  const separator = cursor.rowKey.indexOf(":");
  const table = cursor.rowKey.slice(0, separator);
  if (source.table < table) return gt(source.changeSeq, cursor.changeSeq);
  if (source.table > table) return gte(source.changeSeq, cursor.changeSeq);
  return or(
    gt(source.changeSeq, cursor.changeSeq),
    and(eq(source.changeSeq, cursor.changeSeq), gt(source.id, cursor.rowKey.slice(separator + 1))),
  );
};

const readRows = (
  scope: SyncScope,
  filter: (source: SyncSource) => SQL | undefined,
  limit?: number,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const scopeId = scope.slice(scope.indexOf(":") + 1);

    const tables = yield* Effect.forEach(sourcesOf(scope), (source) =>
      Effect.gen(function* () {
        const query = db
          .select()
          .from(source.rows)
          .where(and(eq(source.scopeColumn, scopeId), filter(source)))
          .orderBy(asc(source.changeSeq), asc(source.id));
        const rows = yield* limit === undefined ? query : query.limit(limit);

        return yield* Effect.forEach(rows, (row) =>
          Schema.decodeUnknownEffect(SyncRow)({ ...row, table: source.table }).pipe(
            Effect.orDie,
            Effect.map((decoded) => ({
              // SAFETY: each synced table has the integer column `change_seq`
              changeSeq: row["changeSeq"] as number,
              key: `${source.table}:${decoded.id}`,
              row: decoded,
            })),
          ),
        );
      }),
    );

    return tables.flat().toSorted((a, b) => a.changeSeq - b.changeSeq || (a.key < b.key ? -1 : 1));
  });

/**
 * A page of the rows of `scope` after `cursor`. A first load can split the rows of one
 * `change_seq`; later pages contain all rows of a `change_seq`, also when they exceed `limit`.
 */
const readScope = (cursor: ScopeCursor, limit: number) =>
  Effect.gen(function* () {
    const scope = cursor.scope;
    const rows = yield* readRows(scope, (source) => afterCursor(source, cursor), limit + 1);
    const last = rows.at(limit - 1);
    const next = rows.at(limit);

    if (last === undefined || next === undefined) {
      const end = rows.at(-1);
      return {
        rows,
        cursor:
          end === undefined
            ? cursor
            : new ScopeCursor({ scope, changeSeq: end.changeSeq, rowKey: null }),
        more: false,
      };
    }

    const firstLoad = cursor.changeSeq === 0 || cursor.rowKey !== null;
    if (firstLoad || next.changeSeq !== last.changeSeq) {
      const rowKey = next.changeSeq === last.changeSeq ? last.key : null;
      return {
        rows: rows.slice(0, limit),
        cursor: new ScopeCursor({ scope, changeSeq: last.changeSeq, rowKey }),
        more: true,
      };
    }

    const complete = rows.slice(0, limit).filter((row) => row.changeSeq < last.changeSeq);
    const page =
      complete.length > 0
        ? complete
        : yield* readRows(scope, (source) => eq(source.changeSeq, last.changeSeq));
    const changeSeq = page.at(-1)?.changeSeq ?? last.changeSeq;
    return { rows: page, cursor: new ScopeCursor({ scope, changeSeq, rowKey: null }), more: true };
  });

const readableScopes = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const playlists = yield* db
      .select({ id: playlist.id })
      .from(playlist)
      .where(and(eq(playlist.ownerId, userId), eq(playlist.deleted, false)));

    return [`user:${userId}`, ...playlists.map((row) => `collection:${row.id}`)].map((scope) =>
      SyncScope.make(scope),
    );
  });

export const syncPull = (request: SyncPullRequest) =>
  Effect.gen(function* () {
    yield* checkVersion(request.protocolVersion);
    const db = yield* Database;
    const identity = yield* ReplicaDatabase;
    const principal = yield* CurrentPrincipal;

    return yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* bindReplica(request.replicaId);
        const readable = yield* readableScopes(principal.userId);
        const requested = new Set(request.scopes.map((cursor) => cursor.scope));

        // After a restore from a backup, the counter can give values again that the client has
        const reset = request.epoch !== null && request.epoch !== identity.epoch;
        const cursors = request.scopes
          .filter((cursor) => readable.includes(cursor.scope))
          .map((cursor) =>
            reset ? new ScopeCursor({ scope: cursor.scope, changeSeq: 0, rowKey: null }) : cursor,
          );

        const rows: Array<SyncRow> = [];
        const pages = yield* Effect.forEach(cursors, (cursor) =>
          Effect.gen(function* () {
            const remaining = pageLimit - rows.length;
            if (remaining <= 0) return { cursor, more: true };

            const page = yield* readScope(cursor, remaining);
            rows.push(...page.rows.map((row) => row.row));
            return page;
          }),
        );

        const catalog = yield* readCatalog(
          principal.userId,
          reset ? null : request.catalogCursor,
          request.wantRecordings,
        );

        return new SyncPullResponse({
          workspaceId: WorkspaceId.make(identity.workspaceId),
          serverReplicaId: ReplicaId.make(identity.replicaId),
          epoch: identity.epoch,
          serverTime: yield* Clock.currentTimeMillis,
          readableScopes: readable,
          rows,
          cursors: pages.map((page) => page.cursor),
          catalog: catalog.page,
          // A readable scope that the client does not follow yet needs another pull
          more:
            pages.some((page) => page.more) ||
            readable.some((scope) => !requested.has(scope)) ||
            catalog.more,
        });
      }),
    );
  });

const decodePlay = (row: typeof playEvent.$inferSelect) =>
  Schema.decodeUnknownEffect(PlayEventRow)({ ...row, table: "play_event" }).pipe(Effect.orDie);

const touchedRows = (mutation: SyncMutation) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const ids = mutation.changes.map((change) => change.row.id);
    const stored = yield* db.select().from(playEvent).where(inArray(playEvent.id, ids));
    const rows = new Map((yield* Effect.forEach(stored, decodePlay)).map((row) => [row.id, row]));

    return ids.map(
      (id) => new SyncTouchedRow({ table: "play_event", id, row: rows.get(id) ?? null }),
    );
  });

const rejectedResult = (mutation: SyncMutation, reason: "forbidden") =>
  Effect.map(
    touchedRows(mutation),
    (rows) => new SyncMutationResult({ id: mutation.id, outcome: "rejected", reason, rows }),
  );

const appendPlay = (row: PlayEventRow, changeSeq: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [stored] = yield* db.select().from(playEvent).where(eq(playEvent.id, row.id));
    const current = stored === undefined ? undefined : yield* decodePlay(stored);

    const merged = mergeRow(current, row);
    if (Option.isNone(merged) || merged.value.table !== "play_event") return;

    const { table: _, ...values } = merged.value;
    yield* db
      .insert(playEvent)
      .values({ ...values, changeSeq })
      .onConflictDoUpdate({ target: playEvent.id, set: { ...values, changeSeq } });
  });

/** Admits the mutations of a client in order, as changes of this server */
export const syncPush = (request: SyncPushRequest) =>
  Effect.gen(function* () {
    yield* checkVersion(request.protocolVersion);
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    const replicaId = request.replicaId;

    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const admitted = yield* bindReplica(replicaId);
        const first = request.mutations[0];
        if (first === undefined)
          return new SyncPushResponse({ lastMutationId: admitted, results: [] });

        // The client no longer waits for the results of earlier mutations
        yield* db
          .delete(syncRejection)
          .where(
            and(eq(syncRejection.replicaId, replicaId), lt(syncRejection.mutationId, first.id)),
          );
        const rejections = new Map(
          (yield* db
            .select()
            .from(syncRejection)
            .where(eq(syncRejection.replicaId, replicaId))).map((row) => [
            row.mutationId,
            row.reason,
          ]),
        );

        const changeSeq = yield* Effect.cached(nextChangeSeq);
        const results: Array<SyncMutationResult> = [];
        let last = admitted;
        for (const mutation of request.mutations) {
          if (mutation.id > last + 1) break;

          // A retry after a lost response gets the same result
          if (mutation.id <= last) {
            const reason = rejections.get(mutation.id);
            if (reason !== undefined) results.push(yield* rejectedResult(mutation, reason));
            continue;
          }

          last = mutation.id;
          const allowed = mutation.changes.every(
            (change) =>
              change.row.userId === principal.userId && change.row.deviceId === principal.deviceId,
          );
          if (!allowed) {
            yield* db
              .insert(syncRejection)
              .values({ replicaId, mutationId: mutation.id, reason: "forbidden" });
            results.push(yield* rejectedResult(mutation, "forbidden"));
            continue;
          }

          const value = yield* changeSeq;
          yield* Effect.forEach(mutation.changes, (change) => appendPlay(change.row, value), {
            discard: true,
          });
        }

        if (last > admitted) {
          yield* db
            .update(replica)
            .set({ lastMutationId: last })
            .where(eq(replica.replicaId, replicaId));
        }
        return new SyncPushResponse({ lastMutationId: last, results });
      }),
    );
  });

/** Publishes after each commit that took a `change_seq` */
export class SyncHub extends Context.Service<SyncHub, PubSub.PubSub<void>>()(
  "@dyad/server-core/SyncHub",
) {}

// Writers do not publish: then `insertPlay` would need the hub, and a hint could come before the
// commit. The counter changes only with a commit.
export const syncHubLayer = Layer.effect(
  SyncHub,
  Effect.gen(function* () {
    const db = yield* Database;
    const hub = yield* PubSub.sliding<void>(1);

    const counter = db
      .select({ value: replicaIdentity.changeSeq })
      .from(replicaIdentity)
      .pipe(
        Effect.map(([row]) => row?.value ?? 0),
        orDieOnDatabaseError("watchSync"),
      );
    const last = yield* Ref.make(yield* counter);

    yield* counter.pipe(
      Effect.flatMap((value) =>
        Ref.getAndSet(last, value).pipe(Effect.map((old) => old !== value)),
      ),
      Effect.flatMap((changed) => (changed ? PubSub.publish(hub, undefined) : Effect.void)),
      Effect.repeat(Schedule.spaced("250 millis")),
      Effect.forkScoped,
    );
    return hub;
  }),
);

/** A hint after the subscription, then at most one hint per 250 ms after changes */
export const syncWatch = Stream.unwrap(
  Effect.gen(function* () {
    const subscription = yield* PubSub.subscribe(yield* SyncHub);

    return Stream.concat(Stream.succeed(undefined), Stream.fromSubscription(subscription)).pipe(
      Stream.map(() => new SyncHint()),
    );
  }),
);
