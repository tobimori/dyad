import {
  libraryItem,
  playEvent,
  playlist,
  playlistEntry,
  replica,
  replicaIdentity,
  source,
  sourcePreference,
  syncRejection,
} from "@dyad/db";
import { Database, ReplicaDatabase, orDieOnDatabaseError } from "@dyad/db/node";
import {
  CurrentPrincipal,
  PlaylistCreate,
  PlaylistEntryAdd,
  PlaylistEntryPatch,
  PlaylistEntryRow,
  PlaylistPatch,
  PlaylistRow,
  ReplicaId,
  SourcePreferenceRow,
  SourcePreferenceSet,
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
  HybridLogicalClock,
  SyncChange,
  SyncMutation,
  SyncPullRequest,
  SyncPushRequest,
  SyncTable,
  UserId,
} from "@dyad/domain";
import { HlcClock, applyChange, changeTarget, sourcePreferenceId, wallTimeOf } from "@dyad/sync";
import { and, asc, eq, gt, gte, lt, or } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { SQLiteColumn, SQLiteTable } from "drizzle-orm/sqlite-core";
import {
  Clock,
  Context,
  Data,
  Effect,
  Layer,
  Match,
  Option,
  PubSub,
  Ref,
  Schedule,
  Schema,
  Stream,
} from "effect";

import { readCatalog } from "./catalog-sync.ts";
import { maxClockAheadMs } from "./clock.ts";
import { cachedProviderSource } from "./provider-cache.ts";
import { addProviderSource } from "./sources.ts";
import { queuePlaylistPush } from "./playlist-push.ts";
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

const syncSources = {
  library_item: new SyncSource({
    table: "library_item",
    rows: libraryItem,
    scopeColumn: libraryItem.userId,
    changeSeq: libraryItem.changeSeq,
    id: libraryItem.id,
  }),
  play_event: new SyncSource({
    table: "play_event",
    rows: playEvent,
    scopeColumn: playEvent.userId,
    changeSeq: playEvent.changeSeq,
    id: playEvent.id,
  }),
  playlist: new SyncSource({
    table: "playlist",
    rows: playlist,
    scopeColumn: playlist.id,
    changeSeq: playlist.changeSeq,
    id: playlist.id,
  }),
  playlist_entry: new SyncSource({
    table: "playlist_entry",
    rows: playlistEntry,
    scopeColumn: playlistEntry.playlistId,
    changeSeq: playlistEntry.changeSeq,
    id: playlistEntry.id,
  }),
  source_preference: new SyncSource({
    table: "source_preference",
    rows: sourcePreference,
    scopeColumn: sourcePreference.userId,
    changeSeq: sourcePreference.changeSeq,
    id: sourcePreference.id,
  }),
} satisfies Record<SyncTable, SyncSource>;

const sourcesOf = (scope: SyncScope) =>
  scope.startsWith("user:")
    ? [syncSources.library_item, syncSources.play_event, syncSources.source_preference]
    : [syncSources.playlist, syncSources.playlist_entry];

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

export const readRow = (table: SyncTable, id: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const source = syncSources[table];
    const [row] = yield* db.select().from(source.rows).where(eq(source.id, id));
    if (row === undefined) return undefined;
    return yield* Schema.decodeUnknownEffect(SyncRow)({ ...row, table }).pipe(Effect.orDie);
  });

export const writeRow = (row: SyncRow, changeSeq: number) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const source = syncSources[row.table];
    const { table: _, ...values } = row;
    yield* db
      .insert(source.rows)
      .values({ ...values, changeSeq })
      .onConflictDoUpdate({ target: source.id, set: { ...values, changeSeq } });
  });

const touchedRows = (mutation: SyncMutation) =>
  Effect.forEach(mutation.changes, (change) =>
    Effect.gen(function* () {
      const { table, id } = changeTarget(change);
      return new SyncTouchedRow({ table, id, row: (yield* readRow(table, id)) ?? null });
    }),
  );

const mutationResult = (
  mutation: SyncMutation,
  outcome: "rejected" | "restamped",
  reason: SyncMutationResult["reason"],
) =>
  Effect.map(
    touchedRows(mutation),
    (rows) => new SyncMutationResult({ id: mutation.id, outcome, reason, rows }),
  );

const hlcOf = (change: SyncChange) =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      "play_event.append": () => null,
      "playlist.create": (create) => create.row.hlc,
      "playlist_entry.add": (add) => add.row.hlc,
      "playlist.patch": (patch) => patch.hlc,
      "playlist_entry.patch": (patch) => patch.hlc,
      "source_preference.set": (set) => set.row.hlc,
    }),
  );

const withHlc = (change: SyncChange, hlc: HybridLogicalClock) =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      "play_event.append": (append) => append,
      "playlist.create": (create) =>
        new PlaylistCreate({ ...create, row: new PlaylistRow({ ...create.row, hlc }) }),
      "playlist_entry.add": (add) =>
        new PlaylistEntryAdd({ ...add, row: new PlaylistEntryRow({ ...add.row, hlc }) }),
      "playlist.patch": (patch) => new PlaylistPatch({ ...patch, hlc }),
      "playlist_entry.patch": (patch) => new PlaylistEntryPatch({ ...patch, hlc }),
      "source_preference.set": (set) =>
        new SourcePreferenceSet({ ...set, row: new SourcePreferenceRow({ ...set.row, hlc }) }),
    }),
  );

// Users edit only their own playlists
const checkChange = (
  change: SyncChange,
  current: SyncRow | undefined,
  rowAt: (table: SyncTable, id: string) => ReturnType<typeof readRow>,
  principal: { readonly userId: UserId; readonly deviceId: string },
) => {
  const editable = (row: SyncRow | undefined) => {
    if (row?.table !== "playlist" || row.deleted) return "not_found" as const;
    return row.ownerId === principal.userId ? null : ("forbidden" as const);
  };

  return Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      "play_event.append": (append) =>
        Effect.succeed(
          append.row.userId === principal.userId && append.row.deviceId === principal.deviceId
            ? null
            : ("forbidden" as const),
        ),
      "playlist.create": (create) =>
        Effect.succeed(
          create.row.ownerId === principal.userId && current === undefined
            ? null
            : ("forbidden" as const),
        ),
      "playlist.patch": () => Effect.succeed(editable(current)),
      "playlist_entry.add": (add) =>
        current === undefined
          ? Effect.map(rowAt("playlist", add.row.playlistId), editable)
          : Effect.succeed("forbidden" as const),
      "playlist_entry.patch": () =>
        current?.table === "playlist_entry"
          ? Effect.map(rowAt("playlist", current.playlistId), editable)
          : Effect.succeed("not_found" as const),
      // One row per user, so that two replicas write the same row
      "source_preference.set": (set) =>
        Effect.map(sourcePreferenceId(principal.userId), (id) =>
          set.row.userId === principal.userId && set.row.id === id ? null : ("forbidden" as const),
        ),
    }),
  );
};

/**
 * Checks the changes of a mutation in order, each against the rows after the changes before it.
 * Returns the rows to write, or the reason to reject the whole mutation.
 */
const admitMutation = (
  mutation: SyncMutation,
  principal: { readonly userId: UserId; readonly deviceId: string },
) =>
  Effect.gen(function* () {
    const clock = yield* HlcClock;
    const now = yield* Clock.currentTimeMillis;
    const rows = new Map<string, SyncRow | undefined>();
    const rowAt = (table: SyncTable, id: string) => {
      const key = `${table}:${id}`;
      return rows.has(key) ? Effect.succeed(rows.get(key)) : readRow(table, id);
    };

    let restamped = false;
    for (const original of mutation.changes) {
      // A client clock far ahead would win every later conflict, so the server stamps the change
      const hlc = hlcOf(original);
      const ahead = hlc !== null && wallTimeOf(hlc) > now + maxClockAheadMs;
      const change = ahead ? withHlc(original, yield* clock.next) : original;
      if (ahead) restamped = true;
      else if (hlc !== null) yield* clock.receive(hlc);

      const { table, id } = changeTarget(change);
      const current = yield* rowAt(table, id);
      const reason = yield* checkChange(change, current, rowAt, principal);
      if (reason !== null) return { reason, rows: [], restamped };

      const merged = applyChange(current, change);
      if (Option.isSome(merged)) rows.set(`${table}:${id}`, merged.value);
    }
    return {
      reason: null,
      rows: [...rows.values()].flatMap((row) => row ?? []),
      restamped,
    };
  });

// A search result enters the catalog when a playlist refers to it, like when it plays
const addEntrySources = (mutations: ReadonlyArray<SyncMutation>) =>
  Effect.forEach(
    mutations.flatMap((mutation) =>
      mutation.changes.flatMap((change) =>
        change.kind === "playlist_entry.add" && change.sourceId !== null
          ? [{ sourceId: change.sourceId, recordingId: change.row.recordingId }]
          : [],
      ),
    ),
    ({ sourceId, recordingId }) =>
      Effect.gen(function* () {
        const db = yield* Database;
        const [known] = yield* db
          .select({ id: source.id })
          .from(source)
          .where(eq(source.id, sourceId));
        if (known !== undefined) return;

        const cached = yield* cachedProviderSource(sourceId);
        if (Option.isSome(cached) && cached.value.recordingId === recordingId) {
          yield* addProviderSource(cached.value);
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("Cannot add the source of an entry", cause)),
      ),
    { discard: true },
  );

/** Admits the mutations of a client in order, as changes of this server */
export const syncPush = (request: SyncPushRequest) =>
  Effect.gen(function* () {
    yield* checkVersion(request.protocolVersion);
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;
    const replicaId = request.replicaId;

    const { response, edited } = yield* db.transaction(() =>
      Effect.gen(function* () {
        const admitted = yield* bindReplica(replicaId);
        const first = request.mutations[0];
        if (first === undefined)
          return {
            response: new SyncPushResponse({ lastMutationId: admitted, results: [] }),
            edited: new Set<string>(),
          };

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
        const edited = new Set<string>();
        let last = admitted;
        for (const mutation of request.mutations) {
          if (mutation.id > last + 1) break;

          // A retry after a lost response gets the same result
          if (mutation.id <= last) {
            const reason = rejections.get(mutation.id);
            if (reason !== undefined) {
              results.push(yield* mutationResult(mutation, "rejected", reason));
            }
            continue;
          }

          last = mutation.id;
          const admission = yield* admitMutation(mutation, principal);
          if (admission.reason !== null) {
            yield* db
              .insert(syncRejection)
              .values({ replicaId, mutationId: mutation.id, reason: admission.reason });
            results.push(yield* mutationResult(mutation, "rejected", admission.reason));
            continue;
          }

          const value = yield* changeSeq;
          yield* Effect.forEach(admission.rows, (row) => writeRow(row, value), { discard: true });
          for (const row of admission.rows) {
            if (row.table === "playlist") edited.add(row.id);
            if (row.table === "playlist_entry") edited.add(row.playlistId);
          }
          if (admission.restamped) results.push(yield* mutationResult(mutation, "restamped", null));
        }

        if (last > admitted) {
          yield* db
            .update(replica)
            .set({ lastMutationId: last })
            .where(eq(replica.replicaId, replicaId));
        }
        return { response: new SyncPushResponse({ lastMutationId: last, results }), edited };
      }),
    );

    // Before the response, so that the next pull of the client finds the recordings
    const rejected = new Set(
      response.results.flatMap((result) => (result.reason === null ? [] : [result.id])),
    );
    yield* addEntrySources(
      request.mutations.filter(
        (mutation) => mutation.id <= response.lastMutationId && !rejected.has(mutation.id),
      ),
    );
    yield* Effect.forEach(
      edited,
      (playlistId) =>
        Effect.gen(function* () {
          const row = yield* readRow("playlist", playlistId);
          if (row?.table === "playlist" && row.link?.direction === "two-way") {
            yield* queuePlaylistPush(playlistId);
          }
        }),
      { discard: true },
    );
    return response;
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
