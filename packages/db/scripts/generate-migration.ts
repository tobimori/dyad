import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Crypto, Data, Effect, FileSystem, Path } from "effect";
import { Hex } from "effect/encoding";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

class GenerateError extends Data.TaggedError("GenerateError")<{ readonly message: string }> {}

const run = Effect.fn(function* (command: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(
    ChildProcess.make(command, args, { stdout: "inherit", stderr: "inherit" }),
  );
  if (exitCode !== 0) {
    return yield* new GenerateError({ message: `${command} failed with exit code ${exitCode}` });
  }
});

// Executables cannot read a migrations folder, so the migrations also go into a JSON module in the
// format of Drizzle's `readMigrationFiles`. `--bundle` only writes the JSON module.
const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const name = process.argv[2];
  if (name === undefined) return yield* new GenerateError({ message: "Give a migration name" });

  const root = path.dirname(import.meta.dirname);
  const folder = path.join(root, "migrations");
  if (name !== "--bundle") {
    yield* run("drizzle-kit", ["generate", "--name", name]);
  }

  const names = (yield* fs.readDirectory(folder)).toSorted();
  const migrations = yield* Effect.forEach(names, (migration) =>
    Effect.gen(function* () {
      const sql = yield* fs.readFileString(path.join(folder, migration, "migration.sql"));
      const hash = yield* crypto.digest("SHA-256", new TextEncoder().encode(sql));
      const time = migration
        .slice(0, 14)
        .replace(/(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/, "$1-$2-$3T$4:$5:$6Z");
      return {
        name: migration,
        folderMillis: Date.parse(time),
        hash: Hex.encode(hash),
        bps: true,
        sql: sql.split("--> statement-breakpoint"),
      };
    }),
  );

  const output = path.join(root, "src/migrations.json");
  yield* fs.writeFileString(output, `${JSON.stringify(migrations, null, 2)}\n`);
  yield* run("vp", ["fmt", output]);
});

program.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
