import { ServerConnection } from "@dyad/client-runtime";
import { HttpUrl, ReplicaId, ServerPairingFailed } from "@dyad/domain";
import { Clock, Console, Effect, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import { deviceConnection, fail, reportFailures } from "./auth.ts";

const failureMessages = {
  invalid_code: "The code is wrong or expired",
  workspace_mismatch:
    "The servers are in different workspaces. A new server joins with `vp run --filter @dyad/server join`.",
  same_server: "The code is from this server",
  unreachable: "Cannot reach the other server",
  upgrade_required: "The servers have different versions. Update both.",
  not_found: "No such peer",
};

const reportPairing = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catch(effect, (error) =>
    Schema.is(ServerPairingFailed)(error)
      ? fail(failureMessages[error.reason])
      : Effect.fail(error),
  );

const codeCommand = Command.make("code", {}, () =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const pairing = yield* connection.createPairingCode();
    const minutes = Math.round((pairing.expiresAt - (yield* Clock.currentTimeMillis)) / 60_000);
    yield* Console.log(
      `${pairing.code} (use it on the other device or replica in ${minutes} minutes)`,
    );
  }).pipe(reportPairing, Effect.provide(deviceConnection), reportFailures),
).pipe(
  Command.withDescription("Show a code that pairs another device or replica with this server"),
);

const pairCommand = Command.make(
  "pair",
  {
    url: Argument.String("url").pipe(
      Argument.withSchema(HttpUrl),
      Argument.withDescription("The URL of the other server"),
    ),
    code: Argument.String("code").pipe(
      Argument.withDescription("A code from `dyad server code` on the other server"),
    ),
  },
  ({ url, code }) =>
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      const peer = yield* connection.pairServer({ url, code });
      yield* Console.log(`Paired with ${peer.replicaId}`);
    }).pipe(reportPairing, Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Pair this server with another server of the same workspace"));

const peersCommand = Command.make("peers", {}, () =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const peers = yield* connection.listServerPeers();
    if (peers.length === 0) return yield* Console.log("No paired servers");
    const now = yield* Clock.currentTimeMillis;

    for (const peer of peers) {
      const direction = [peer.connects ? "connects" : null, peer.accepts ? "accepts" : null]
        .filter((part) => part !== null)
        .join(", ");
      const synced =
        peer.syncedAt === null
          ? "never synced"
          : `synced ${Math.round((now - peer.syncedAt) / 1000)} s ago`;
      const error = peer.error === null ? "" : `  ${peer.error}`;
      yield* Console.log(
        `${peer.replicaId}  ${peer.url ?? "-"}  ${direction || "-"}  ${synced}${error}`,
      );
    }
  }).pipe(reportPairing, Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("List the paired servers"));

const unpairCommand = Command.make(
  "unpair",
  { replicaId: Argument.String("replica-id").pipe(Argument.withSchema(ReplicaId)) },
  ({ replicaId }) =>
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      yield* connection.unpairServer({ replicaId });
      yield* Console.log("Unpaired. The data that already synced stays on both servers.");
    }).pipe(reportPairing, Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Stop syncing with a paired server (admin)"));

export const serverCommand = Command.make("server").pipe(
  Command.withDescription("Pair servers of one workspace"),
  Command.withSubcommands([codeCommand, pairCommand, peersCommand, unpairCommand]),
);
