// @effect-diagnostics-next-line nodeBuiltinImport:off -- the replica writes to a log file, which `effect/process` 4.0.5 cannot do
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- `spawn` needs a file descriptor for the log
import * as NodeFS from "node:fs";
import { isSea } from "node:sea";

import { Config, Data, Effect, FileSystem, Path, Schedule } from "effect";
import { HttpClient } from "effect/http";
import envPaths from "env-paths";

/** The replica of this device: its database and the local port of its server */
export const localReplica = Effect.gen(function* () {
  const path = yield* Path.Path;
  const port = yield* Config.Port("DYAD_REPLICA_PORT").pipe(Config.withDefault(4319));
  return {
    dataDirectory: path.join(envPaths("dyad", { suffix: "" }).data, "replica"),
    port,
    origin: `http://127.0.0.1:${port}`,
  };
});

export class ReplicaNotStarted extends Data.TaggedError("ReplicaNotStarted")<{
  readonly logFile: string;
}> {}

const healthy = (origin: string) =>
  HttpClient.get(`${origin}/health`).pipe(
    Effect.map((response) => response.status === 200),
    Effect.timeout("1 second"),
    Effect.orElseSucceed(() => false),
  );

/**
 * Starts `dyad replica run` as a child of this process, unless a replica already answers on its
 * port. The child stops with the scope.
 */
export const startLocalReplica = Effect.gen(function* () {
  const replica = yield* localReplica;
  if (yield* healthy(replica.origin)) return replica;

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const folder = envPaths("dyad", { suffix: "" }).log;
  yield* fs.makeDirectory(folder, { recursive: true });
  const logFile = path.join(folder, "replica.log");

  // The executable is the CLI itself; under Node, the script and its flags come first
  const script = isSea() ? [] : [...process.execArgv, process.argv[1] ?? ""];
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      const log = NodeFS.openSync(logFile, "a");
      const child = NodeChildProcess.spawn(process.execPath, [...script, "replica", "run"], {
        stdio: ["ignore", log, log],
        env: { ...process.env, DYAD_REPLICA_PORT: String(replica.port) },
      });
      NodeFS.closeSync(log);
      return child;
    }),
    (child) => Effect.sync(() => child.kill()),
  );

  const ready = yield* healthy(replica.origin).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("250 millis"),
      until: (ok) => ok,
      times: 120,
    }),
  );
  if (!ready) return yield* new ReplicaNotStarted({ logFile });
  return replica;
});
