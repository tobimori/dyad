// @effect-diagnostics-next-line nodeBuiltinImport:off -- the server must outlive this script and write to a log file, which `effect/process` 4.0.5 cannot do
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- `spawn` needs a file descriptor for the log
import * as NodeFS from "node:fs";

import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { NodeRuntime, NodeServices, NodeSocketServer } from "@effect/platform-node";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import {
  Clock,
  Console,
  Crypto,
  Data,
  Effect,
  FileSystem,
  Option,
  Path,
  Schedule,
  Schema,
} from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { Hex } from "effect/encoding";
import { NetAddress } from "effect/net";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { SandboxFile, readSandboxFile, serverUrl, writeSandboxFile } from "./sandbox-file.ts";

class SandboxError extends Data.TaggedError("SandboxError")<{ readonly message: string }> {}

const serverCommand = Effect.gen(function* () {
  const path = yield* Path.Path;
  const repositoryRoot = path.dirname(import.meta.dirname);
  const main = path.join(repositoryRoot, "apps/server/src/main.ts");
  return { repositoryRoot, arguments: ["--conditions=development", main] };
});

const toneFiles = [
  { file: "tone-a.flac", frequency: 440, title: "Tone A" },
  { file: "tone-b.flac", frequency: 550, title: "Tone B" },
  { file: "tone-c.flac", frequency: 660, title: "Tone C" },
];

const generateTones = Effect.fn(function* (library: string) {
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  for (const [index, tone] of toneFiles.entries()) {
    const command = ChildProcess.make("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=${tone.frequency}:duration=3`,
      "-metadata",
      `title=${tone.title}`,
      "-metadata",
      "artist=Dyad Sandbox",
      "-metadata",
      "album=Sandbox Tones",
      "-metadata",
      `track=${index + 1}`,
      path.join(library, tone.file),
    ]);
    const exitCode = yield* spawner.exitCode(command);
    if (exitCode !== 0) {
      return yield* new SandboxError({ message: `ffmpeg failed with exit code ${exitCode}` });
    }
  }
});

// The source stays read-only, so that the sandbox never changes a real database
const copyDatabase = (source: string, target: string) =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    yield* sql`VACUUM INTO ${target}`;
  }).pipe(Effect.provide(SqliteClient.layer({ filename: source, readonly: true })));

const FirstUser = Schema.Struct({ id: Schema.String, username: Schema.String });

// The server stores only the SHA-256 of the hex token, like `createDevice` in `server-core`
const insertDevice = (database: string, token: string) =>
  Effect.gen(function* () {
    const sql = yield* SqliteClient.SqliteClient;
    const crypto = yield* Crypto.Crypto;

    const rows = yield* sql`SELECT id, username FROM user ORDER BY created_at LIMIT 1`;
    if (rows[0] === undefined) {
      return yield* new SandboxError({ message: "The database has no user" });
    }
    const user = yield* Schema.decodeUnknownEffect(FirstUser)(rows[0]);

    const tokenHash = yield* crypto.digest("SHA-256", new TextEncoder().encode(token));
    yield* sql`INSERT INTO device ${sql.insert({
      id: yield* crypto.randomUUIDv7(),
      user_id: user.id,
      name: "sandbox",
      token_hash: Hex.encode(tokenHash),
      created_at: yield* Clock.currentTimeMillis,
    })}`;
    return user.username;
  }).pipe(Effect.provide(SqliteClient.layer({ filename: database })));

const freePort = Effect.gen(function* () {
  const server = yield* NodeSocketServer.make({ host: "127.0.0.1", port: 0 });
  if (NetAddress.isUnixPathAddress(server.address)) {
    return yield* new SandboxError({ message: "Expected a TCP address" });
  }
  return server.address.port;
}).pipe(Effect.scoped);

const startServer = Effect.fn(function* (logFile: string, environment: Record<string, string>) {
  const command = yield* serverCommand;
  return yield* Effect.try({
    try: () => {
      const log = NodeFS.openSync(logFile, "a");
      const child = NodeChildProcess.spawn(process.execPath, command.arguments, {
        cwd: command.repositoryRoot,
        detached: true,
        env: { ...process.env, ...environment },
        stdio: ["ignore", log, log],
      });
      child.unref();
      NodeFS.closeSync(log);
      return child.pid;
    },
    catch: (cause) => new SandboxError({ message: `Cannot start the server: ${String(cause)}` }),
  });
});

const isRunning = (pid: number) =>
  Effect.try(() => process.kill(pid, 0)).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

// The server logs the setup code before it accepts connections
const readSetupCode = Effect.fn(function* (logFile: string) {
  const fs = yield* FileSystem.FileSystem;
  const log = yield* fs.readFileString(logFile);
  const match = /setup code ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(log);
  if (match?.[1] === undefined) {
    return yield* new SandboxError({ message: `No setup code in ${logFile}` });
  }
  return match[1];
});

const start = Command.make(
  "sandbox",
  {
    from: Flag.File("from", { mustExist: true }).pipe(
      Flag.withDescription("Copy this replica.sqlite with VACUUM INTO and use its first user"),
      Flag.optional,
    ),
    library: Flag.Directory("library", { mustExist: true }).pipe(
      Flag.withDescription("Use this folder as DYAD_LIBRARY_DIR (default: an empty folder)"),
      Flag.optional,
    ),
    tones: Flag.Boolean("tones").pipe(
      Flag.withDescription("Put three short tagged FLAC files into the empty library folder"),
      Flag.withDefault(false),
    ),
  },
  ({ from, library, tones }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;

      if (tones && Option.isSome(library)) {
        return yield* new SandboxError({ message: "Use --tones or --library, not both" });
      }

      const folder = yield* fs.makeTempDirectory({ prefix: "dyad-sandbox-" });
      const dataDirectory = path.join(folder, "data");
      const tokenFile = path.join(folder, "token");
      const logFile = path.join(folder, "server.log");
      yield* fs.makeDirectory(dataDirectory);

      const libraryDirectory = Option.match(library, {
        onSome: (directory) => path.resolve(directory),
        onNone: () => path.join(folder, "library"),
      });
      if (Option.isNone(library)) yield* fs.makeDirectory(libraryDirectory);
      if (tones) yield* generateTones(libraryDirectory);

      const token = Hex.encode(yield* crypto.randomBytes(32));
      if (Option.isSome(from)) {
        const database = path.join(dataDirectory, "replica.sqlite");
        yield* copyDatabase(path.resolve(from.value), database);
        const username = yield* insertDevice(database, token);
        yield* fs.writeFileString(tokenFile, token, { mode: 0o600 });
        yield* Console.log(`Copied ${from.value}; the token signs in as ${username}`);
      }

      const port = yield* freePort;
      const pid = yield* startServer(logFile, {
        APP_ENV: "development",
        PORT: String(port),
        DYAD_DATA_DIR: dataDirectory,
        DYAD_LIBRARY_DIR: libraryDirectory,
      });
      if (pid === undefined) {
        return yield* new SandboxError({ message: `The server did not start. See ${logFile}` });
      }

      const sandbox = new SandboxFile({ port, pid, dataDirectory, tokenFile, logFile });
      yield* writeSandboxFile(folder, sandbox);

      const ready = Effect.gen(function* () {
        const connection = yield* ServerConnection;
        yield* connection.describe().pipe(
          Effect.retry({ schedule: Schedule.spaced("250 millis"), while: () => isRunning(pid) }),
          Effect.timeout("30 seconds"),
          Effect.mapError(
            () =>
              new SandboxError({
                message: `The server did not start. See ${logFile}. Remove the sandbox with: vp run sandbox stop ${folder}`,
              }),
          ),
        );

        if (Option.isSome(from)) return;

        const password = Hex.encode(yield* crypto.randomBytes(16));
        const session = yield* connection.setup({
          setupCode: yield* readSetupCode(logFile),
          username: "sandbox",
          password,
          deviceName: "sandbox",
        });
        yield* fs.writeFileString(tokenFile, session.token, { mode: 0o600 });
        yield* fs.writeFileString(
          path.join(folder, "credentials.json"),
          `${JSON.stringify({ username: "sandbox", password }, null, 2)}\n`,
          { mode: 0o600 },
        );
      });
      yield* ready.pipe(
        Effect.provide(serverConnectionLayer(serverUrl(sandbox), Option.none())),
        Effect.scoped,
      );

      yield* Console.log(
        [
          `Sandbox: ${folder}`,
          `Server:  ${serverUrl(sandbox)} (PID ${pid})`,
          `Log:     ${logFile}`,
          `Call:    vp run rpc ${folder} describe`,
          `Stop:    vp run sandbox stop ${folder}`,
        ].join("\n"),
      );
    }),
).pipe(
  Command.withDescription(
    "Start a Dyad server in the background with its own data folder in the temporary folder and a free port",
  ),
);

// A PID can belong to another process after the server stopped, so the PID alone is not proof
const checkServerProcess = Effect.fn(function* (sandbox: SandboxFile) {
  const fs = yield* FileSystem.FileSystem;

  if (process.platform === "linux") {
    const environ = yield* fs.readFileString(`/proc/${sandbox.pid}/environ`);
    const expected = `DYAD_DATA_DIR=${sandbox.dataDirectory}`;
    if (!environ.split("\0").includes(expected)) {
      return yield* new SandboxError({
        message: `PID ${sandbox.pid} does not have ${expected}. Nothing was stopped.`,
      });
    }
    return;
  }

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const commandLine = yield* spawner.string(
    ChildProcess.make("ps", ["-o", "command=", "-p", String(sandbox.pid)]),
  );
  const command = yield* serverCommand;
  const expected = [process.execPath, ...command.arguments].join(" ");
  if (commandLine.trim() !== expected) {
    return yield* new SandboxError({
      message: `PID ${sandbox.pid} is not a Dyad server. Nothing was stopped.`,
    });
  }
  yield* Console.log(
    "This system has no /proc, so only the command line was checked, not DYAD_DATA_DIR",
  );
});

const stopServer = Effect.fn(function* (sandbox: SandboxFile) {
  if (!(yield* isRunning(sandbox.pid))) {
    return yield* Console.log(`The server (PID ${sandbox.pid}) is not running`);
  }

  yield* checkServerProcess(sandbox);
  yield* Effect.try(() => process.kill(sandbox.pid, "SIGTERM"));
  yield* isRunning(sandbox.pid).pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: (running) => !running }),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () =>
        Effect.fail(new SandboxError({ message: `PID ${sandbox.pid} did not stop in 10 seconds` })),
    }),
  );
  yield* Console.log(`Stopped the server (PID ${sandbox.pid})`);
});

const stop = Command.make(
  "stop",
  {
    folder: Argument.Directory("sandbox-folder", { mustExist: true }).pipe(
      Argument.withDescription("The folder that `vp run sandbox` printed"),
    ),
    keep: Flag.Boolean("keep").pipe(
      Flag.withDescription("Keep the sandbox folder"),
      Flag.withDefault(false),
    ),
  },
  ({ folder, keep }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sandbox = yield* readSandboxFile(folder);

      yield* stopServer(sandbox);

      if (keep) return yield* Console.log(`Kept ${folder}`);

      yield* fs.remove(folder, { recursive: true });
      yield* Console.log(`Removed ${folder}`);
    }),
).pipe(Command.withDescription("Stop the server of a sandbox and remove its folder"));

Command.run(start.pipe(Command.withSubcommands([stop])), { version: "0.0.0" }).pipe(
  Effect.catchTag("SandboxError", (error) =>
    Console.error(error.message).pipe(
      Effect.andThen(
        Effect.sync(() => {
          process.exitCode = 1;
        }),
      ),
    ),
  ),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
