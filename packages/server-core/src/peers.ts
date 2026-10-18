import { catalogAssertion, replicaIdentity, serverPeer, user } from "@dyad/db";
import { Database, ReplicaDatabase, orDieOnDatabaseError } from "@dyad/db/node";
import {
  CurrentPeer,
  CurrentPrincipal,
  PairingCode,
  PeerAdmin,
  PeerAuthentication,
  PeerCursor,
  PeerLink,
  PeerPullRequest,
  PeerPullResponse,
  PeerPushRequest,
  PeerRedeemRequest,
  PeerRpc,
  ReplicaId,
  ServerPairingFailed,
  ServerPeer,
  Unauthorized,
  UpgradeRequired,
  UserId,
  WorkspaceId,
  syncProtocolVersion,
} from "@dyad/domain";
import { and, eq, isNotNull } from "drizzle-orm";
import { Clock, Context, Crypto, Data, Duration, Effect, Layer, PubSub, Ref } from "effect";
import { FetchHttpClient, Headers } from "effect/http";
import { RpcClient, RpcMiddleware, RpcSerialization, RpcServer } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";

import { hashPassword, normalizeCode, randomBytes, randomCode, sha256 } from "./auth.ts";
import { hex } from "./ids.ts";
import { mergePeerRows, readChanges } from "./replication.ts";
import { SyncHub } from "./sync.ts";

const pageLimit = 500;
const codeLifetimeMs = 10 * 60 * 1000;
const roundIntervalMs = 5000;
const maxBackoffMs = 60_000;

class PendingServerPairing extends Data.Class<{
  readonly userId: UserId;
  readonly expiresAt: number;
}> {}

/** Server pairing codes stay in memory, like device pairing codes */
export class ServerPairingCodes extends Context.Service<
  ServerPairingCodes,
  Ref.Ref<ReadonlyMap<string, PendingServerPairing>>
>()("@dyad/server-core/ServerPairingCodes") {}

export const serverPairingCodesLayer = Layer.effect(
  ServerPairingCodes,
  Ref.make<ReadonlyMap<string, PendingServerPairing>>(new Map()),
);

/**
 * Per peer, the `change_seq` values of rows that this replica took unchanged from that peer. They
 * do not go back to it. After a restart, they go back once and change nothing there.
 */
export class PeerEchoes extends Context.Service<PeerEchoes, Map<string, Set<number>>>()(
  "@dyad/server-core/PeerEchoes",
) {}

export const peerEchoesLayer = Layer.sync(PeerEchoes, () => new Map());

const addEcho = (peer: string, changeSeq: number | undefined) =>
  Effect.gen(function* () {
    if (changeSeq === undefined) return;
    const echoes = yield* PeerEchoes;
    echoes.set(peer, (echoes.get(peer) ?? new Set()).add(changeSeq));
  });

// Values before the cursor are no longer read, so they go
const echoesAfter = (peer: string, cursor: PeerCursor) =>
  Effect.gen(function* () {
    const echoes = (yield* PeerEchoes).get(peer) ?? new Set();
    for (const changeSeq of echoes) if (changeSeq < cursor.changeSeq) echoes.delete(changeSeq);
    return [...echoes];
  });

const requireAdmin = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;
  const [row] = yield* db
    .select({ role: user.role })
    .from(user)
    .where(eq(user.id, principal.userId));
  if (row?.role !== "admin") return yield* new ServerPairingFailed({ reason: "not_admin" });
  return principal;
});

export const createServerPairingCode = Effect.gen(function* () {
  const principal = yield* requireAdmin;
  const codes = yield* ServerPairingCodes;
  const now = yield* Clock.currentTimeMillis;
  const code = yield* randomCode;
  const expiresAt = now + codeLifetimeMs;

  yield* Ref.update(codes, (pending) => {
    const next = new Map([...pending].filter(([, pairing]) => pairing.expiresAt > now));
    next.set(code, new PendingServerPairing({ userId: principal.userId, expiresAt }));
    return next;
  });
  return new PairingCode({ code, expiresAt });
});

const checkVersion = (protocolVersion: number) =>
  protocolVersion === syncProtocolVersion
    ? Effect.void
    : Effect.fail(new UpgradeRequired({ serverProtocolVersion: syncProtocolVersion }));

/** Makes a token for the redeeming server. Only its hash stays here. */
const redeem = (request: PeerRedeemRequest) =>
  Effect.gen(function* () {
    yield* checkVersion(request.protocolVersion);
    const db = yield* Database;
    const identity = yield* ReplicaDatabase;
    const codes = yield* ServerPairingCodes;
    const now = yield* Clock.currentTimeMillis;
    const code = normalizeCode(request.code);

    // A code works once
    const pairing = yield* Ref.modify(codes, (pending) => {
      const next = new Map(pending);
      next.delete(code);
      return [pending.get(code), next];
    });
    if (pairing === undefined || pairing.expiresAt <= now) {
      return yield* new ServerPairingFailed({ reason: "invalid_code" });
    }
    if (request.replicaId === identity.replicaId) {
      return yield* new ServerPairingFailed({ reason: "same_server" });
    }
    // Two independent workspaces never merge
    if (request.workspaceId !== null && request.workspaceId !== identity.workspaceId) {
      return yield* new ServerPairingFailed({ reason: "workspace_mismatch" });
    }

    const [admin] = yield* db.select().from(user).where(eq(user.id, pairing.userId));
    if (admin === undefined) return yield* new ServerPairingFailed({ reason: "invalid_code" });

    const token = hex(yield* randomBytes(32));
    const tokenHash = yield* sha256(token);
    yield* db
      .insert(serverPeer)
      .values({ replicaId: request.replicaId, tokenHash, createdAt: now })
      .onConflictDoUpdate({ target: serverPeer.replicaId, set: { tokenHash } });

    return new PeerLink({
      token,
      replicaId: ReplicaId.make(identity.replicaId),
      workspaceId: WorkspaceId.make(identity.workspaceId),
      admin: new PeerAdmin({
        id: UserId.make(admin.id),
        username: admin.username,
        role: admin.role,
      }),
    });
  });

export const peerAuthenticationLayer = Layer.effect(
  PeerAuthentication,
  Effect.gen(function* () {
    const services = yield* Effect.context<Database | Crypto.Crypto>();

    return (effect, { headers }) =>
      Effect.gen(function* () {
        const db = yield* Database;
        const header = headers.authorization ?? "";
        if (!header.startsWith("Bearer ")) return yield* new Unauthorized();

        const tokenHash = yield* sha256(header.slice("Bearer ".length));
        const [row] = yield* db
          .select({ replicaId: serverPeer.replicaId })
          .from(serverPeer)
          .where(eq(serverPeer.tokenHash, tokenHash))
          .pipe(orDieOnDatabaseError("authenticatePeer"));
        if (row === undefined) return yield* new Unauthorized();
        return yield* Effect.provideService(effect, CurrentPeer, ReplicaId.make(row.replicaId));
      }).pipe(Effect.provide(services));
  }),
);

const peerPull = (request: PeerPullRequest) =>
  Effect.gen(function* () {
    yield* checkVersion(request.protocolVersion);
    const db = yield* Database;
    const identity = yield* ReplicaDatabase;

    // After a restore from a backup, the counter can give values again that the peer has
    const reset = request.epoch !== null && request.epoch !== identity.epoch;
    const cursor = reset ? new PeerCursor({ changeSeq: 0, rowKey: null }) : request.cursor;
    const echoes = yield* echoesAfter(yield* CurrentPeer, cursor);
    const page = yield* db.transaction(() => readChanges(cursor, pageLimit, echoes));
    return new PeerPullResponse({
      replicaId: ReplicaId.make(identity.replicaId),
      workspaceId: WorkspaceId.make(identity.workspaceId),
      epoch: identity.epoch,
      ...page,
    });
  });

const peerPush = (request: PeerPushRequest) =>
  Effect.gen(function* () {
    yield* checkVersion(request.protocolVersion);
    const db = yield* Database;
    yield* addEcho(yield* CurrentPeer, yield* db.transaction(() => mergePeerRows(request.rows)));
  });

const peerRevoke = Effect.gen(function* () {
  const db = yield* Database;
  const peer = yield* CurrentPeer;
  const [row] = yield* db.select().from(serverPeer).where(eq(serverPeer.replicaId, peer));
  // This server can also connect to the peer; that pairing stays
  yield* row?.url == null
    ? db.delete(serverPeer).where(eq(serverPeer.replicaId, peer))
    : db.update(serverPeer).set({ tokenHash: null }).where(eq(serverPeer.replicaId, peer));
});

/** The calls of other server replicas, at `/peer` */
export const peerRoutes = RpcServer.layerHttp({
  group: PeerRpc,
  path: "/peer",
  protocol: "http",
}).pipe(
  Layer.provide(
    PeerRpc.toLayer({
      peerRedeem: (request) => redeem(request).pipe(orDieOnDatabaseError("peerRedeem")),
      peerPull: (request) => peerPull(request).pipe(orDieOnDatabaseError("peerPull")),
      peerPush: (request) => peerPush(request).pipe(orDieOnDatabaseError("peerPush")),
      peerRevoke: () => peerRevoke.pipe(orDieOnDatabaseError("peerRevoke")),
    }),
  ),
  Layer.provide(peerAuthenticationLayer),
  Layer.provide(RpcSerialization.layerJson),
);

class PeerConnection extends Context.Service<
  PeerConnection,
  RpcClient.FromGroup<typeof PeerRpc, RpcClientError>
>()("@dyad/server-core/PeerConnection") {}

const peerConnection = (url: string, token: string | null) =>
  Layer.effect(PeerConnection, RpcClient.make(PeerRpc)).pipe(
    Layer.provide(
      RpcMiddleware.layerClient(PeerAuthentication, ({ request, next }) =>
        next(
          token === null
            ? request
            : {
                ...request,
                headers: Headers.set(request.headers, "authorization", `Bearer ${token}`),
              },
        ),
      ),
    ),
    Layer.provide(
      RpcClient.layerProtocolHttp({ url: new URL("/peer", url).href }).pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(FetchHttpClient.layer),
      ),
    ),
  );

// The answer of a peer that cannot be reached is not a pairing reason
const redeemAt = (url: string, workspaceId: WorkspaceId | null, code: string) =>
  Effect.gen(function* () {
    const identity = yield* ReplicaDatabase;
    const connection = yield* PeerConnection;
    return yield* connection.peerRedeem(
      new PeerRedeemRequest({
        code,
        replicaId: ReplicaId.make(identity.replicaId),
        workspaceId,
        protocolVersion: syncProtocolVersion,
      }),
    );
  }).pipe(
    Effect.provide(peerConnection(url, null)),
    Effect.catchTag("UpgradeRequired", () =>
      Effect.fail(new ServerPairingFailed({ reason: "upgrade_required" })),
    ),
    Effect.catchTag("RpcClientError", () =>
      Effect.fail(new ServerPairingFailed({ reason: "unreachable" })),
    ),
  );

/** Only a server without users can join a workspace */
export class JoinFailed extends Data.TaggedError("JoinFailed")<{
  readonly reason: "has_users" | ServerPairingFailed["reason"];
}> {}

// The peer at the URL is another server now
class OtherServer extends Data.TaggedError("OtherServer")<{}> {}

/**
 * Joins the workspace of the server at `url` before this server starts for the first time. This
 * server takes its workspace and makes its first admin with the ID of the admin who made the
 * code, with a password of this server.
 */
export const joinWorkspace = (options: {
  readonly url: URL;
  readonly code: string;
  readonly password: string;
}) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const users = yield* db.$count(user);
    if (users > 0) return yield* new JoinFailed({ reason: "has_users" });

    const url = options.url.origin;
    const link = yield* redeemAt(url, null, options.code).pipe(
      Effect.mapError((error) => new JoinFailed({ reason: error.reason })),
    );
    const now = yield* Clock.currentTimeMillis;
    const passwordHash = yield* hashPassword(options.password);

    yield* db.transaction(() =>
      Effect.gen(function* () {
        yield* db.update(replicaIdentity).set({ workspaceId: link.workspaceId });
        yield* db.update(catalogAssertion).set({ workspaceId: link.workspaceId });
        yield* db.insert(user).values({
          id: link.admin.id,
          username: link.admin.username,
          passwordHash,
          role: link.admin.role,
          createdAt: now,
        });
        yield* db.insert(serverPeer).values({
          replicaId: link.replicaId,
          url,
          token: link.token,
          createdAt: now,
        });
      }),
    );
    return link;
  });

const peerSummary = (row: typeof serverPeer.$inferSelect) =>
  new ServerPeer({
    replicaId: ReplicaId.make(row.replicaId),
    url: row.url,
    connects: row.url !== null && row.token !== null,
    accepts: row.tokenHash !== null,
    syncedAt: row.syncedAt,
    error: row.error,
  });

/** Pairs with a server of the same workspace, for example again after an unpair */
export const pairServer = (options: { readonly url: URL; readonly code: string }) =>
  Effect.gen(function* () {
    yield* requireAdmin;
    const db = yield* Database;
    const identity = yield* ReplicaDatabase;
    const url = options.url.origin;

    const link = yield* redeemAt(url, WorkspaceId.make(identity.workspaceId), options.code);
    const values = {
      url,
      token: link.token,
      epoch: null,
      pulledSeq: 0,
      pulledRowKey: null,
      pushedSeq: 0,
      pushedRowKey: null,
      error: null,
    };
    const [row] = yield* db
      .insert(serverPeer)
      .values({ replicaId: link.replicaId, createdAt: yield* Clock.currentTimeMillis, ...values })
      .onConflictDoUpdate({ target: serverPeer.replicaId, set: values })
      .returning();
    if (row === undefined) return yield* Effect.die("The peer row is missing");
    yield* PubSub.publish(yield* SyncHub, undefined);
    return peerSummary(row);
  });

export const listServerPeers = Effect.gen(function* () {
  yield* requireAdmin;
  const db = yield* Database;
  const rows = yield* db.select().from(serverPeer);
  return rows.map(peerSummary);
});

/** Removes the pairing here, and on the peer when this server connects to it and reaches it */
export const unpairServer = (replicaId: ReplicaId) =>
  Effect.gen(function* () {
    yield* requireAdmin;
    const db = yield* Database;
    const [row] = yield* db.select().from(serverPeer).where(eq(serverPeer.replicaId, replicaId));
    if (row === undefined) return yield* new ServerPairingFailed({ reason: "not_found" });

    if (row.url !== null && row.token !== null) {
      yield* Effect.gen(function* () {
        yield* (yield* PeerConnection).peerRevoke();
      }).pipe(
        Effect.provide(peerConnection(row.url, row.token)),
        Effect.timeout("5 seconds"),
        Effect.catchCause(() =>
          Effect.logWarning("The peer did not confirm the unpair").pipe(
            Effect.annotateLogs({ peer: replicaId }),
          ),
        ),
      );
    }
    yield* db.delete(serverPeer).where(eq(serverPeer.replicaId, replicaId));
  });

/** Stored on the peer row. Never a message: it can contain the URL. */
class PeerSyncFailed extends Data.TaggedError("PeerSyncFailed")<{
  readonly reason: "revoked" | "upgrade_required" | "unreachable" | "other_server";
}> {}

const saveState = (replicaId: string, state: Partial<typeof serverPeer.$inferInsert>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db.update(serverPeer).set(state).where(eq(serverPeer.replicaId, replicaId));
  });

/** Pulls the peer's rows after the cursor, then pushes this replica's rows after the peer's cursor */
const syncPeer = (peer: typeof serverPeer.$inferSelect) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const connection = yield* PeerConnection;
    let epoch = peer.epoch;
    let pulled = new PeerCursor({ changeSeq: peer.pulledSeq, rowKey: peer.pulledRowKey });
    let pushed = new PeerCursor({ changeSeq: peer.pushedSeq, rowKey: peer.pushedRowKey });

    while (true) {
      const response = yield* connection.peerPull(
        new PeerPullRequest({ protocolVersion: syncProtocolVersion, epoch, cursor: pulled }),
      );
      if (response.replicaId !== peer.replicaId) return yield* new OtherServer();

      // A peer restored from a backup can miss rows that this replica pushed earlier
      if (epoch !== null && response.epoch !== epoch) {
        pushed = new PeerCursor({ changeSeq: 0, rowKey: null });
        (yield* PeerEchoes).delete(peer.replicaId);
      }
      epoch = response.epoch;
      pulled = response.cursor;
      yield* db.transaction(() =>
        Effect.gen(function* () {
          yield* addEcho(peer.replicaId, yield* mergePeerRows(response.rows));
          yield* saveState(peer.replicaId, {
            epoch,
            pulledSeq: pulled.changeSeq,
            pulledRowKey: pulled.rowKey,
            pushedSeq: pushed.changeSeq,
            pushedRowKey: pushed.rowKey,
          });
        }),
      );
      if (!response.more) break;
    }

    while (true) {
      const echoes = yield* echoesAfter(peer.replicaId, pushed);
      const page = yield* db.transaction(() => readChanges(pushed, pageLimit, echoes));
      if (page.rows.length === 0) break;

      yield* connection.peerPush(
        new PeerPushRequest({ protocolVersion: syncProtocolVersion, rows: page.rows }),
      );
      pushed = page.cursor;
      yield* saveState(peer.replicaId, {
        pushedSeq: pushed.changeSeq,
        pushedRowKey: pushed.rowKey,
      });
      if (!page.more) break;
    }

    yield* saveState(peer.replicaId, { syncedAt: yield* Clock.currentTimeMillis, error: null });
  }).pipe(
    Effect.provide(peerConnection(peer.url ?? "", peer.token)),
    Effect.catchTags({
      Unauthorized: () => Effect.fail(new PeerSyncFailed({ reason: "revoked" })),
      UpgradeRequired: () => Effect.fail(new PeerSyncFailed({ reason: "upgrade_required" })),
      RpcClientError: () => Effect.fail(new PeerSyncFailed({ reason: "unreachable" })),
      OtherServer: () => Effect.fail(new PeerSyncFailed({ reason: "other_server" })),
    }),
    orDieOnDatabaseError("syncPeer"),
  );

/**
 * Syncs with each peer that this server connects to, after each local commit and every 5 s. A
 * peer that fails waits longer, up to a minute. A revoked token stops the sync with that peer.
 */
export const peerSyncLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    const subscription = yield* PubSub.subscribe(yield* SyncHub);
    const waits = new Map<string, { readonly failures: number; readonly until: number }>();

    const round = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const peers = yield* db
        .select()
        .from(serverPeer)
        .where(and(isNotNull(serverPeer.url), isNotNull(serverPeer.token)));

      yield* Effect.forEach(
        peers.filter((peer) => (waits.get(peer.replicaId)?.until ?? 0) <= now),
        (peer) =>
          syncPeer(peer).pipe(
            Effect.tap(() => Effect.sync(() => waits.delete(peer.replicaId))),
            Effect.catchTag("PeerSyncFailed", ({ reason }) =>
              Effect.gen(function* () {
                const failures = (waits.get(peer.replicaId)?.failures ?? 0) + 1;
                const waitMs = Math.min(roundIntervalMs * 2 ** failures, maxBackoffMs);
                waits.set(peer.replicaId, { failures, until: now + waitMs });
                yield* saveState(peer.replicaId, { error: reason });
                // The peer forgot the token, so asking again cannot succeed
                if (reason === "revoked") yield* saveState(peer.replicaId, { token: null });
                yield* Effect.logWarning("Cannot sync with a server peer").pipe(
                  Effect.annotateLogs({ peer: peer.replicaId, reason }),
                );
              }),
            ),
          ),
        { discard: true },
      );
    });

    yield* round.pipe(
      Effect.catchCause((cause) => Effect.logError("Server peer sync failed", cause)),
      Effect.andThen(
        Effect.raceFirst(PubSub.take(subscription), Effect.sleep(Duration.millis(roundIntervalMs))),
      ),
      Effect.forever,
      Effect.forkScoped,
    );
  }),
);
