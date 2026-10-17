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

const writeTokens = (tokens: typeof DeviceTokens.Type) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* tokenFile;
    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    // The token gives full access to the user's account on the server
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(DeviceTokens)(tokens), {
      mode: 0o600,
    });
  });

export const loadDeviceToken = (serverUrl: string) =>
  readTokens.pipe(
    Effect.map((tokens) =>
      Option.map(Option.fromUndefinedOr(tokens[new URL(serverUrl).origin]), Redacted.make),
    ),
  );

export const saveDeviceToken = (serverUrl: string, token: string) =>
  Effect.gen(function* () {
    const tokens = yield* readTokens;
    yield* writeTokens({ ...tokens, [new URL(serverUrl).origin]: token });
  });

export const deleteDeviceToken = (serverUrl: string) =>
  Effect.gen(function* () {
    const tokens = yield* readTokens;
    const origin = new URL(serverUrl).origin;
    yield* writeTokens(
      Object.fromEntries(Object.entries(tokens).filter(([key]) => key !== origin)),
    );
  });
