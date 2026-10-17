import { Effect, FileSystem, Path, Schema } from "effect";

/** The `sandbox.json` file that `sandbox` writes and `sandbox stop` and `rpc` read */
export class SandboxFile extends Schema.Class<SandboxFile>("SandboxFile")({
  port: Schema.Int,
  pid: Schema.Int,
  dataDirectory: Schema.String,
  tokenFile: Schema.String,
  logFile: Schema.String,
}) {}

const sandboxFilePath = Effect.fn(function* (folder: string) {
  const path = yield* Path.Path;
  return path.join(path.resolve(folder), "sandbox.json");
});

export const readSandboxFile = Effect.fn(function* (folder: string) {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(yield* sandboxFilePath(folder));
  return yield* Schema.decodeEffect(Schema.fromJsonString(SandboxFile))(text);
});

export const writeSandboxFile = Effect.fn(function* (folder: string, sandbox: SandboxFile) {
  const fs = yield* FileSystem.FileSystem;
  const encoded = yield* Schema.encodeEffect(SandboxFile)(sandbox);
  yield* fs.writeFileString(
    yield* sandboxFilePath(folder),
    `${JSON.stringify(encoded, null, 2)}\n`,
  );
});

export const serverUrl = (sandbox: SandboxFile) => `http://127.0.0.1:${sandbox.port}`;
