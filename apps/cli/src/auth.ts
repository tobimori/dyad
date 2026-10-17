import { hostname } from "node:os";

import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import type { DeviceSession } from "@dyad/domain";
import {
  AccountLinkFailed,
  AuthenticationFailed,
  DeviceId,
  HttpUrl,
  Unauthorized,
} from "@dyad/domain";
import { Clock, Config, Console, Data, Effect, Layer, Option, Redacted, Schema } from "effect";
import { Argument, Command, Prompt } from "effect/cli";

import { BrowserLoginError } from "./browser-login.ts";
import { deleteDeviceToken, loadDeviceToken, saveDeviceToken } from "./devices.ts";

/** Only the origin, because device tokens are per origin and the client sets its own paths */
export const serverUrl = Config.schema(HttpUrl, "DYAD_SERVER_URL").pipe(
  Config.withDefault(new URL("http://127.0.0.1:4310")),
  Config.map((url) => url.origin),
);

export class NotSignedIn extends Data.TaggedError("NotSignedIn")<{}> {}

const notSignedIn = "Not signed in. Use `dyad login`, `dyad pair` or `dyad setup`.";

const publicConnection = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* serverUrl;
    return serverConnectionLayer(url, Option.none());
  }),
);

/** Fails with `NotSignedIn` when this CLI has no device token for the server */
export const deviceToken = Effect.gen(function* () {
  const token = yield* loadDeviceToken(yield* serverUrl);
  if (Option.isNone(token)) return yield* new NotSignedIn();
  return token.value;
});

export const deviceConnection = Layer.unwrap(
  Effect.gen(function* () {
    const url = yield* serverUrl;
    const token = yield* deviceToken;
    return serverConnectionLayer(url, Option.some(token));
  }),
);

const failureMessages = {
  invalid_credentials: "Wrong username or password",
  invalid_code: "The code is wrong or expired",
  already_set_up: "The server already has a user. Use `dyad login`.",
};

export const fail = (message: string) =>
  Console.error(message).pipe(
    Effect.andThen(
      Effect.sync(() => {
        process.exitCode = 1;
      }),
    ),
  );

/** Prints a sentence for the failures that a user can fix */
export const reportFailures = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.catch(effect, (error) => {
    if (Schema.is(AuthenticationFailed)(error)) return fail(failureMessages[error.reason]);
    if (Schema.is(AccountLinkFailed)(error))
      return fail(`Cannot link the account: ${error.reason}`);
    if (error instanceof BrowserLoginError) return fail(error.reason);
    if (error instanceof NotSignedIn) return fail(notSignedIn);
    if (Schema.is(Unauthorized)(error)) {
      return fail("The server does not accept this device. Sign in again.");
    }
    return Effect.fail(error);
  });

const deviceNamePrompt = Prompt.String({ message: "Device name", default: hostname() });

const saveSession = (session: DeviceSession, username: string) =>
  Effect.gen(function* () {
    yield* saveDeviceToken(yield* serverUrl, session.token);
    yield* Console.log(`Signed in as ${username}`);
  });

const setupCommand = Command.make("setup", {}, () =>
  Effect.gen(function* () {
    const setupCode = yield* Prompt.String({ message: "Setup code from the server log" });
    const username = yield* Prompt.String({ message: "Username" });
    const password = yield* Prompt.Password({ message: "Password (at least 8 characters)" });
    const repeated = yield* Prompt.Password({ message: "Repeat the password" });
    if (Redacted.value(password) !== Redacted.value(repeated)) {
      return yield* fail("The passwords are not the same");
    }
    const deviceName = yield* deviceNamePrompt;

    const connection = yield* ServerConnection;
    const session = yield* connection.setup({
      setupCode,
      username,
      password: Redacted.value(password),
      deviceName,
    });
    yield* saveSession(session, username);
  }).pipe(Effect.provide(publicConnection), reportFailures),
).pipe(Command.withDescription("Create the first admin of a new server"));

const loginCommand = Command.make("login", {}, () =>
  Effect.gen(function* () {
    const username = yield* Prompt.String({ message: "Username" });
    const password = yield* Prompt.Password({ message: "Password" });
    const deviceName = yield* deviceNamePrompt;

    const connection = yield* ServerConnection;
    const session = yield* connection.login({
      username,
      password: Redacted.value(password),
      deviceName,
    });
    yield* saveSession(session, username);
  }).pipe(Effect.provide(publicConnection), reportFailures),
).pipe(Command.withDescription("Sign in with a username and password"));

const pairCommand = Command.make("pair", { code: Argument.String("code") }, ({ code }) =>
  Effect.gen(function* () {
    const deviceName = yield* deviceNamePrompt;
    const connection = yield* ServerConnection;
    const session = yield* connection.pair({ code, deviceName });
    yield* saveDeviceToken(yield* serverUrl, session.token);
    yield* Console.log("Paired");
  }).pipe(Effect.provide(publicConnection), reportFailures),
).pipe(Command.withDescription("Sign in with a pairing code from another device"));

const pairingCodeCommand = Command.make("pairing-code", {}, () =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const pairing = yield* connection.createPairingCode();
    const now = yield* Clock.currentTimeMillis;
    const minutes = Math.round((pairing.expiresAt - now) / 60_000);
    yield* Console.log(`${pairing.code} (use it with \`dyad pair\` in ${minutes} minutes)`);
  }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Show a code that signs in another device"));

const devicesCommand = Command.make("devices", {}, () =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const devices = yield* connection.listDevices();
    for (const device of devices) {
      yield* Console.log(`${device.id}  ${device.name}${device.current ? " (this device)" : ""}`);
    }
  }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("List the devices of your account"));

const removeDeviceCommand = Command.make(
  "remove-device",
  { deviceId: Argument.String("device-id").pipe(Argument.withSchema(DeviceId)) },
  ({ deviceId }) =>
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      yield* connection.removeDevice({ deviceId });
      yield* Console.log("Removed");
    }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Sign out another device"));

const logoutCommand = Command.make("logout", {}, () =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    // A device that the server already removed only deletes its local token
    const devices = yield* connection
      .listDevices()
      .pipe(Effect.catchTag("Unauthorized", () => Effect.succeed([])));
    const current = devices.find((device) => device.current);
    if (current !== undefined) yield* connection.removeDevice({ deviceId: current.id });

    yield* deleteDeviceToken(yield* serverUrl);
    yield* Console.log("Signed out");
  }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Sign out this device"));

export const authCommands = [
  setupCommand,
  loginCommand,
  pairCommand,
  pairingCodeCommand,
  devicesCommand,
  removeDeviceCommand,
  logoutCommand,
] as const;
