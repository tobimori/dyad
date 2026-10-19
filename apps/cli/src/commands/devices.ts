import { Effect, FileSystem, Option, Path, Redacted, Schema } from "effect";
import envPaths from "env-paths";

// One device token per server origin
const DeviceTokens = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));

const tokenFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(envPaths("dyad", { suffix: "" }).config, "devices.json");
});

const readTokens = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* tokenFile;
  const exists = yield* fs.exists(file);
  if (!exists) return {};

  const text = yield* fs.readFileString(file);
  return yield* Schema.decodeEffect(DeviceTokens)(text);
});

const writeTokens = Effect.fn(function* (tokens: typeof DeviceTokens.Type) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = yield* tokenFile;
  yield* fs.makeDirectory(path.dirname(file), { recursive: true });
  // The token gives full access to the user's account on the server. `mode` applies only when
  // the write creates the file.
  yield* fs.writeFileString(file, yield* Schema.encodeEffect(DeviceTokens)(tokens), {
    mode: 0o600,
  });
  yield* fs.chmod(file, 0o600);
});

export const loadDeviceToken = (origin: string) =>
  readTokens.pipe(
    Effect.map((tokens) => Option.map(Option.fromUndefinedOr(tokens[origin]), Redacted.make)),
  );

export const saveDeviceToken = Effect.fn("saveDeviceToken")(function* (
  origin: string,
  token: string,
) {
  const tokens = yield* readTokens;
  yield* writeTokens({ ...tokens, [origin]: token });
});

export const deleteDeviceToken = Effect.fn("deleteDeviceToken")(function* (origin: string) {
  const tokens = yield* readTokens;
  yield* writeTokens(Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== origin)));
});
