import {
  libraryItem,
  playlist,
  playlistEntry,
  recording,
  syncQueue,
  syncScope,
} from "@dyad/db/client";
import {
  CatalogCursor,
  DeviceId,
  HybridLogicalClock,
  PlayEventAppend,
  PlayEventRow,
  Principal,
  RecordingId,
  ReplicaId,
  ScopeCursor,
  SyncMutation,
  SyncPullRequest,
  SyncPushRequest,
  SyncScope,
  UserId,
  syncProtocolVersion,
} from "@dyad/domain";
import type { PlayContext, SyncChange, SyncPullResponse } from "@dyad/domain";
import { changeTarget, makeHlcClock } from "@dyad/sync";
import { and, asc, count, eq, inArray, isNull, lte, max, sql } from "drizzle-orm";
import {
  Clock,
  Context,
  Crypto,
  Data,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Schema,
  Stream,
  SubscriptionRef,
} from "effect";
import { Reactivity } from "effect/reactivity";

import { ServerConnection } from "../connection.ts";
import {
  AccountProviders,
  ClientDatabase,
  accountProvidersState,
  missingRecordingsState,
  stateKey,
} from "./database.ts";
import { playlistEdits } from "./playlists.ts";
import {
  applyChanges,
  catalogTables,
  deleteScope,
  mergeRows,
  replaceGroup,
  replaceMissingRemoteTracks,
  replaceRow,
} from "./rows.ts";

const replicaIdState = stateKey("replicaId", ReplicaId);
// The user and device of the device token, for the rows of own mutations
const principalState = stateKey("principal", Principal);
const epochState = stateKey("epoch", Schema.String);
const catalogCursorState = stateKey("catalogCursor", CatalogCursor);
const nextMutationIdState = stateKey("nextMutationId", Schema.Int);
// Server time minus local time at the last pull, so that HLCs follow the server clock
const clockOffsetState = stateKey("clockOffset", Schema.Finite);

/** The replica learns its user and device at its first connection, and needs them for own rows */
export class ReplicaUnbound extends Data.TaggedError("ReplicaUnbound")<{}> {}

const pushLimit = 500;
const wantLimit = 1000;

const makeReplica = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  const connection = yield* ServerConnection;
  const reactivity = yield* Reactivity.Reactivity;
  const crypto = yield* Crypto.Crypto;
  const context = yield* Effect.context<ClientDatabase>();
  const status = yield* SubscriptionRef.make<"offline" | "live" | "upgrade_required">("offline");
  const wake = yield* Queue.sliding<void>(1);

  const newReplicaId = Effect.gen(function* () {
    const id = ReplicaId.make(yield* crypto.randomUUIDv4());
    yield* replicaIdState.set(id);
    return id;
  }).pipe(Effect.orDie);
  const replicaId = yield* Ref.make(
    yield* Option.match(yield* replicaIdState.get, {
      onNone: () => newReplicaId,
      onSome: Effect.succeed,
    }),
  );

  const clockOffset = yield* Ref.make(Option.getOrElse(yield* clockOffsetState.get, () => 0));
  const makeClock = (latest: HybridLogicalClock | null) =>
    Effect.gen(function* () {
      return yield* makeHlcClock({
        replicaId: yield* Ref.get(replicaId),
        latest,
        now: Effect.map(
          Effect.all([Clock.currentTimeMillis, Ref.get(clockOffset)]),
          ([now, offset]) => Math.round(now + offset),
        ),
      });
    });
  const stored = yield* Effect.all([
    db.select({ hlc: max(playlist.hlc) }).from(playlist),
    db.select({ hlc: max(playlistEntry.hlc) }).from(playlistEntry),
    db.select({ hlc: max(libraryItem.hlc) }).from(libraryItem),
  ]).pipe(Effect.orDie);
  const latest =
    stored
      .flatMap(([row]) => row?.hlc ?? [])
      .toSorted()
      .at(-1) ?? null;
  const clock = yield* Ref.make(
    yield* makeClock(latest === null ? null : HybridLogicalClock.make(latest)),
  );

  // One local transaction. Atoms that read the changed tables run again after the commit.
  const commit = <E>(change: Effect.Effect<Iterable<string>, E, ClientDatabase>) =>
    db
      .transaction(() => change)
      .pipe(
        Effect.orDie,
        Effect.flatMap((tables) => reactivity.invalidate([...tables])),
      );

  const queued = (limit?: number) =>
    Effect.gen(function* () {
      const query = db.select().from(syncQueue).orderBy(asc(syncQueue.mutationId));
      const rows = yield* limit === undefined ? query : query.limit(limit);
      return yield* Effect.forEach(rows, (row) =>
        Schema.decodeUnknownEffect(SyncMutation)(row.mutation),
      );
    }).pipe(Effect.orDie);

  // A new replica, or a server that lost the binding, admits the queue only under new IDs
  const renumber = (first: number) =>
    commit(
      Effect.gen(function* () {
        const mutations = yield* queued();
        yield* db.delete(syncQueue);
        for (const [index, mutation] of mutations.entries()) {
          const renumbered = new SyncMutation({ ...mutation, id: first + index });
          yield* db.insert(syncQueue).values({
            mutationId: renumbered.id,
            mutation: yield* Schema.encodeEffect(SyncMutation)(renumbered),
          });
        }
        yield* nextMutationIdState.set(first + mutations.length);
        return [];
      }).pipe(Effect.orDie),
    );

  const push = Effect.gen(function* () {
    let renumbered = false;
    while (true) {
      const mutations = yield* queued(pushLimit);
      const first = mutations[0];
      if (first === undefined) return;

      const response = yield* connection.syncPush(
        new SyncPushRequest({
          replicaId: yield* Ref.get(replicaId),
          protocolVersion: syncProtocolVersion,
          mutations,
        }),
      );
      if (response.lastMutationId < first.id - 1 && !renumbered) {
        renumbered = true;
        yield* renumber(response.lastMutationId + 1);
        continue;
      }

      yield* commit(
        Effect.gen(function* () {
          yield* db.delete(syncQueue).where(lte(syncQueue.mutationId, response.lastMutationId));
          const tables = new Set<string>();
          const touched = new Set<string>();
          for (const result of response.results) {
            if (result.outcome === "rejected") {
              yield* Effect.logWarning("The server rejected a change").pipe(
                Effect.annotateLogs({ mutationId: result.id, reason: result.reason }),
              );
            }
            for (const row of result.rows) {
              yield* replaceRow(row.table, row.id, row.row);
              tables.add(row.table);
              touched.add(`${row.table}:${row.id}`);
            }
          }

          // Queued changes of the replaced rows apply again
          const pending = yield* queued();
          const again = pending.flatMap((mutation) =>
            mutation.changes.filter((change) => {
              const target = changeTarget(change);
              return touched.has(`${target.table}:${target.id}`);
            }),
          );
          yield* applyChanges(again);
          return tables;
        }),
      );
      if (response.lastMutationId < (mutations.at(-1)?.id ?? 0)) return;
    }
  });

  // Bound recordings that the replica refers to and does not have, and that the server has
  const wantedRecordings = Effect.gen(function* () {
    const missing = Option.getOrElse(yield* missingRecordingsState.get, () => []);
    const referenced = db
      .select({ id: libraryItem.entityId })
      .from(libraryItem)
      .where(eq(libraryItem.deleted, false))
      .union(
        db
          .select({ id: playlistEntry.recordingId })
          .from(playlistEntry)
          .where(eq(playlistEntry.deleted, false)),
      )
      .as("referenced");
    const rows = yield* db
      .select({ id: referenced.id })
      .from(referenced)
      .where(
        and(
          sql`${referenced.id} NOT IN (SELECT ${recording.id} FROM ${recording})`,
          sql`${referenced.id} NOT IN (SELECT value FROM json_each(${JSON.stringify(missing)}))`,
        ),
      )
      .limit(wantLimit);
    return rows.map((row) => RecordingId.make(row.id));
  }).pipe(Effect.orDie);

  const learnPrincipal = (response: SyncPullResponse) =>
    Effect.gen(function* () {
      if (Option.isSome(yield* principalState.get)) return;
      const userScope = response.readableScopes.find((scope) => scope.startsWith("user:"));
      const devices = yield* connection.listDevices();
      const device = devices.find((candidate) => candidate.current);
      if (userScope === undefined || device === undefined) return;

      yield* principalState.set(
        new Principal({
          userId: UserId.make(userScope.slice("user:".length)),
          deviceId: DeviceId.make(device.id),
        }),
      );
    });

  const applyPage = (
    followed: ReadonlyArray<typeof syncScope.$inferSelect>,
    response: SyncPullResponse,
  ) =>
    Effect.gen(function* () {
      const tables = new Set<string>(yield* mergeRows(response.rows));

      for (const cursor of response.cursors) {
        yield* db
          .update(syncScope)
          .set({ changeSeq: cursor.changeSeq, rowKey: cursor.rowKey })
          .where(eq(syncScope.scope, cursor.scope));
      }

      const followedScopes = new Set(followed.map((row) => row.scope));
      const added = response.readableScopes.filter((scope) => !followedScopes.has(scope));
      const removed = followed.filter(
        (row) => !response.readableScopes.includes(SyncScope.make(row.scope)),
      );
      if (added.length > 0 || removed.length > 0 || !response.more) tables.add("sync_scope");
      for (const scope of added) {
        yield* db.insert(syncScope).values({ scope, changeSeq: 0, rowKey: null, loadedAt: null });
      }
      for (const row of removed) {
        for (const table of yield* deleteScope(SyncScope.make(row.scope))) tables.add(table);
        yield* db.delete(syncScope).where(eq(syncScope.scope, row.scope));
      }
      // A scope stays "Syncing" until its first load ends
      if (!response.more) {
        yield* db
          .update(syncScope)
          .set({ loadedAt: yield* Clock.currentTimeMillis })
          .where(and(isNull(syncScope.loadedAt), inArray(syncScope.scope, [...followedScopes])));
      }

      const catalog = response.catalog;
      for (const group of catalog.groups) yield* replaceGroup(group);
      if (catalog.groups.length > 0) for (const table of catalogTables) tables.add(table);
      if (catalog.missing.length > 0) {
        yield* replaceMissingRemoteTracks(catalog.missing, catalog.missingRemoteTracks);
        tables.add("library_remote_track");
      }
      const arrived = new Set<string>(
        catalog.groups.flatMap((group) => group.recordings.map((row) => row.id)),
      );
      const missing = Option.getOrElse(yield* missingRecordingsState.get, () => []);
      yield* missingRecordingsState.set(
        [...new Set([...missing, ...catalog.missing])].filter((id) => !arrived.has(id)),
      );
      // The value column cannot hold `null`, which the server sends while the catalog is empty
      yield* catalog.cursor === null
        ? catalogCursorState.clear
        : catalogCursorState.set(catalog.cursor);
      yield* epochState.set(response.epoch);
      return tables;
    }).pipe(Effect.orDie);

  // Wanted recordings wait until the catalog pages end, so that a first load gets each group once
  const pull = Effect.gen(function* () {
    let wanted: ReadonlyArray<RecordingId> = [];
    while (true) {
      const followed = yield* db.select().from(syncScope).pipe(Effect.orDie);
      const response = yield* connection.syncPull(
        new SyncPullRequest({
          replicaId: yield* Ref.get(replicaId),
          protocolVersion: syncProtocolVersion,
          epoch: Option.getOrNull(yield* epochState.get),
          scopes: followed.map(
            (row) =>
              new ScopeCursor({
                scope: SyncScope.make(row.scope),
                changeSeq: row.changeSeq,
                rowKey: row.rowKey,
              }),
          ),
          catalogCursor: Option.getOrNull(yield* catalogCursorState.get),
          wantRecordings: wanted,
        }),
      );
      yield* learnPrincipal(response);
      const offset = response.serverTime - (yield* Clock.currentTimeMillis);
      yield* Ref.set(clockOffset, offset);
      yield* clockOffsetState.set(offset);
      yield* commit(applyPage(followed, response));
      if (response.more) {
        wanted = [];
        continue;
      }

      const next = yield* wantedRecordings;
      if (next.every((id) => wanted.includes(id))) return;
      wanted = next;
    }
  });

  // Views decide without the server which sources the user can play
  const refreshProviders = Effect.gen(function* () {
    const [providers, accounts] = yield* Effect.all([
      connection.listAccountProviders(),
      connection.listAccounts(),
    ]);
    const value = new AccountProviders({
      names: Object.fromEntries(providers.map((provider) => [provider.provider, provider.name])),
      linked: accounts.map((account) => account.provider),
    });
    yield* commit(accountProvidersState.set(value).pipe(Effect.as(["client_state"])));
  });

  const sync = Effect.gen(function* () {
    yield* push;
    yield* pull;
    yield* refreshProviders;
    yield* SubscriptionRef.set(status, "live");
  }).pipe(
    // Another device uses this replica ID, for example after a new sign-in
    Effect.catchTag("ReplicaMismatch", () =>
      newReplicaId.pipe(
        Effect.flatMap((id) => Ref.set(replicaId, id)),
        // Clock values carry the replica ID
        Effect.andThen(Ref.get(clock)),
        Effect.flatMap((old) => old.next),
        Effect.flatMap(makeClock),
        Effect.flatMap((next) => Ref.set(clock, next)),
        Effect.andThen(renumber(1)),
        Effect.andThen(push),
        Effect.andThen(pull),
      ),
    ),
    Effect.provideContext(context),
  );

  // The first hint comes when the subscription is ready, so no commit falls between watch and pull
  const watch = Effect.gen(function* () {
    if ((yield* SubscriptionRef.get(status)) === "upgrade_required") return yield* Effect.never;
    yield* connection.syncWatch().pipe(
      Stream.runForEach(() => Queue.offer(wake, undefined)),
      Effect.catchCause((cause) => Effect.logDebug("The sync watch ended", cause)),
    );
    yield* SubscriptionRef.set(status, "offline");
    yield* Effect.sleep("1 second");
  });
  yield* Effect.forkScoped(Effect.forever(watch));

  // The queue stays when the server needs another protocol version
  yield* Effect.forkScoped(
    Effect.gen(function* () {
      while ((yield* SubscriptionRef.get(status)) !== "upgrade_required") {
        yield* Queue.take(wake);
        yield* sync.pipe(
          Effect.catchTag("UpgradeRequired", () => SubscriptionRef.set(status, "upgrade_required")),
          Effect.catchTag("RpcClientError", (error) => Effect.logDebug("Cannot sync", error)),
          Effect.catchCause((cause) => Effect.logWarning("Cannot sync", cause)),
        );
      }
    }),
  );

  /** Applies the changes of `build` as one mutation and queues it for the server */
  const mutate = <A>(
    build: (
      next: Effect.Effect<HybridLogicalClock>,
    ) => Effect.Effect<
      readonly [A, ReadonlyArray<SyncChange>],
      never,
      ClientDatabase | Crypto.Crypto
    >,
  ) =>
    Effect.gen(function* () {
      const next = (yield* Ref.get(clock)).next;
      const [value, tables] = yield* db
        .transaction(() =>
          Effect.gen(function* () {
            const [value, changes] = yield* build(next);
            const [first, ...rest] = changes;
            if (first === undefined) return [value, new Set<string>()] as const;

            const id = Option.getOrElse(yield* nextMutationIdState.get, () => 1);
            const mutation = new SyncMutation({ id, changes: [first, ...rest] });
            yield* db.insert(syncQueue).values({
              mutationId: id,
              mutation: yield* Schema.encodeEffect(SyncMutation)(mutation),
            });
            yield* nextMutationIdState.set(id + 1);
            return [value, yield* applyChanges(changes)] as const;
          }),
        )
        .pipe(Effect.provideService(Crypto.Crypto, crypto), Effect.orDie);
      yield* reactivity.invalidate([...tables]);
      yield* Queue.offer(wake, undefined);
      return value;
    }).pipe(Effect.provideContext(context));

  const owner = Effect.flatMap(principalState.get, (principal) =>
    Option.match(principal, {
      onNone: () => Effect.fail(new ReplicaUnbound()),
      onSome: (value) => Effect.succeed(value.userId),
    }),
  ).pipe(Effect.provideContext(context));

  return {
    /** `live` while the server sends hints */
    status,
    /** Records a play of this device */
    appendPlay: (play: {
      readonly id: string;
      readonly sourceId: string;
      readonly context: typeof PlayContext.Type;
      readonly startedAt: number;
      readonly playedMs: number;
      readonly completed: boolean;
    }) =>
      Effect.gen(function* () {
        const principal = yield* principalState.get;
        if (Option.isNone(principal)) return yield* new ReplicaUnbound();

        const row = new PlayEventRow({
          table: "play_event",
          id: play.id,
          userId: principal.value.userId,
          deviceId: principal.value.deviceId,
          sourceId: play.sourceId,
          recordingId: null,
          startedAt: Math.round(play.startedAt),
          playedMs: Math.round(play.playedMs),
          completed: play.completed,
          context: play.context,
          scrobbled: false,
        });
        yield* mutate(() =>
          Effect.succeed([
            undefined,
            [new PlayEventAppend({ kind: "play_event.append", schemaVersion: 1, row })],
          ]),
        );
      }).pipe(Effect.provideContext(context)),
    /** Edits of the user's playlists. They apply at once, also offline. */
    playlists: playlistEdits(mutate, owner),
    /** The mutations that the server has not acknowledged */
    pending: db
      .select({ count: count() })
      .from(syncQueue)
      .pipe(
        Effect.map(([row]) => row?.count ?? 0),
        Effect.orDie,
      ),
    /** Sends the queue now, for example before a sign-out */
    push: push.pipe(Effect.provideContext(context)),
  };
});

/**
 * The client replica: the user's scopes and the catalog groups that they refer to, in the local
 * database. It pulls after each hint of the server and pushes the mutation queue.
 */
export class Replica extends Context.Service<Replica, Effect.Success<typeof makeReplica>>()(
  "@dyad/client-runtime/Replica",
) {}

export const replicaLayer = Layer.effect(Replica, makeReplica);
