import { NodeSocket } from "@effect/platform-node";
import { Config, Data, Effect, Option, Schedule, Schema, Stream, SubscriptionRef } from "effect";
import type { NonEmptyReadonlyArray } from "effect/Array";
import { Socket } from "effect/socket";

const opcodes = { handshake: 0, frame: 1, close: 2, ping: 3, pong: 4 } as const;

// Discord accepts 5 updates in 20 seconds
const updateGap = "4 seconds";

/** A Listening activity, as `SET_ACTIVITY` sends it */
export class Activity extends Schema.Class<Activity>("Activity")({
  type: Schema.Literal(2),
  /** `1` shows `state` in the member list, for example "Listening to Daft Punk" */
  status_display_type: Schema.optional(Schema.Literal(1)),
  details: Schema.String,
  state: Schema.optional(Schema.String),
  /** Unix time in milliseconds */
  timestamps: Schema.Struct({ start: Schema.Finite, end: Schema.optional(Schema.Finite) }),
  assets: Schema.Struct({
    /** An HTTPS URL or the name of an art asset of the Discord application */
    large_image: Schema.String,
    large_text: Schema.optional(Schema.String),
  }),
}) {}

class ReadyEvent extends Schema.Class<ReadyEvent>("ReadyEvent")({
  evt: Schema.Literal("READY"),
}) {}

class ErrorEvent extends Schema.Class<ErrorEvent>("ErrorEvent")({
  evt: Schema.Literal("ERROR"),
  data: Schema.Struct({ code: Schema.Finite, message: Schema.String }),
}) {}

const Event = Schema.fromJsonString(Schema.Union([ReadyEvent, ErrorEvent]));

const CloseReason = Schema.fromJsonString(
  Schema.Struct({ code: Schema.Finite, message: Schema.String }),
);

class Frame extends Data.Class<{ readonly opcode: number; readonly json: string }> {}

class DiscordClosed extends Data.TaggedError("DiscordClosed")<{ readonly reason: string }> {}

// Flatpak and Snap builds of Discord and Vesktop put the socket in a subfolder of `XDG_RUNTIME_DIR`
const sandboxFolders = [
  "app/com.discordapp.Discord",
  "app/dev.vencord.Vesktop",
  ".flatpak/com.discordapp.Discord/xdg-run",
  ".flatpak/dev.vencord.Vesktop/xdg-run",
  "snap.discord",
  "snap.discord-canary",
];

const variable = (name: string) => Config.String(name).pipe(Config.withDefault(""));

/**
 * The socket paths in the order that Discord uses. `DYAD_DISCORD_IPC_DIR` replaces all folders,
 * for a Discord build that puts its socket somewhere else.
 */
const socketPaths = Effect.gen(function* () {
  const env = yield* Config.all({
    folder: variable("DYAD_DISCORD_IPC_DIR"),
    runtime: variable("XDG_RUNTIME_DIR"),
    tmpdir: variable("TMPDIR"),
    tmp: variable("TMP"),
    temp: variable("TEMP"),
  });
  const windows = process.platform === "win32";
  const separator = windows ? "\\" : "/";

  const sandboxed =
    env.runtime === ""
      ? []
      : [env.runtime, ...sandboxFolders.map((folder) => `${env.runtime}/${folder}`)];
  const temporary = [env.tmpdir, env.tmp, env.temp, "/tmp"].filter((folder) => folder !== "");

  const defaults = windows ? ["\\\\?\\pipe"] : [...new Set([...sandboxed, ...temporary])];
  const folders = env.folder === "" ? defaults : [env.folder];

  return folders.flatMap((folder) =>
    Array.from({ length: 10 }, (_, index) => `${folder}${separator}discord-ipc-${index}`),
  );
}).pipe(Effect.orDie);

const open = (paths: ReadonlyArray<string>) =>
  Effect.firstSuccessOf(
    paths.map((path) =>
      Effect.gen(function* () {
        const socket = yield* NodeSocket.makeNet({ path, openTimeout: "1 second" });
        const pull = yield* Socket.readerBytes(socket);
        const writer = yield* socket.writer;
        return { pull, writer };
      }),
    ),
  );

// A frame is an `int32` opcode and an `int32` length, both little endian, then the JSON in UTF-8
const encode = (opcode: number, json: string) => {
  const body = new TextEncoder().encode(json);
  const frame = new Uint8Array(8 + body.length);
  const view = new DataView(frame.buffer);
  view.setInt32(0, opcode, true);
  view.setInt32(4, body.length, true);
  frame.set(body, 8);
  return frame;
};

// One read can hold part of a frame or more than one frame
const frameReader = (
  pull: Effect.Effect<NonEmptyReadonlyArray<Uint8Array>, Socket.SocketError>,
) => {
  let buffer = new Uint8Array(0);

  const take = () => {
    if (buffer.length < 8) return undefined;

    const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const length = view.getInt32(4, true);
    if (buffer.length < 8 + length) return undefined;

    const json = new TextDecoder().decode(buffer.subarray(8, 8 + length));
    const frame = new Frame({ opcode: view.getInt32(0, true), json });
    buffer = buffer.subarray(8 + length);
    return frame;
  };

  const append = (chunks: ReadonlyArray<Uint8Array>) => {
    const size = chunks.reduce((total, chunk) => total + chunk.length, buffer.length);
    const next = new Uint8Array(size);
    next.set(buffer);

    let offset = buffer.length;
    for (const chunk of chunks) {
      next.set(chunk, offset);
      offset += chunk.length;
    }
    buffer = next;
  };

  return Effect.gen(function* () {
    while (true) {
      const frame = take();
      if (frame !== undefined) return frame;
      append(yield* pull);
    }
  });
};

const closedBy = (frame: Frame) =>
  Schema.decodeEffect(CloseReason)(frame.json).pipe(
    Effect.map((reason) => `${reason.code} ${reason.message}`),
    Effect.orElseSucceed(() => "no reason"),
    Effect.flatMap((reason) => new DiscordClosed({ reason })),
  );

// Succeeds when an open connection drops, so that the next connection starts the backoff again
const connect = Effect.fn(
  function* (clientId: string, activity: SubscriptionRef.SubscriptionRef<Activity | null>) {
    const { pull, writer } = yield* open(yield* socketPaths);
    const next = frameReader(pull);
    const send = (opcode: number, json: string) => writer.write(encode(opcode, json));

    yield* send(opcodes.handshake, JSON.stringify({ v: 1, client_id: clientId }));

    const first = yield* next.pipe(Effect.timeout("5 seconds"));
    if (first.opcode === opcodes.close) return yield* closedBy(first);
    const ready = yield* Schema.decodeEffect(Event)(first.json).pipe(Effect.option);
    if (Option.isNone(ready) || ready.value.evt !== "READY") {
      return yield* new DiscordClosed({ reason: "no READY event" });
    }
    yield* Effect.logInfo("Connected to Discord");

    let nonce = 0;
    const setActivity = (value: Activity | null) => {
      nonce += 1;
      const command = {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity: value },
        nonce: String(nonce),
      };
      return send(opcodes.frame, JSON.stringify(command));
    };

    // Runs before the socket closes, and fails at once when the socket is already closed
    yield* Effect.addFinalizer(() =>
      setActivity(null).pipe(Effect.timeout("1 second"), Effect.ignore),
    );

    const receive = Effect.gen(function* () {
      while (true) {
        const frame = yield* next;

        if (frame.opcode === opcodes.ping) {
          yield* send(opcodes.pong, frame.json);
          continue;
        }
        if (frame.opcode === opcodes.close) return yield* closedBy(frame);

        const event = yield* Schema.decodeEffect(Event)(frame.json).pipe(Effect.option);
        if (Option.isSome(event) && event.value.evt === "ERROR") {
          yield* Effect.logWarning("Discord rejected the activity", event.value.data.message);
        }
      }
    });

    // Sends the newest activity and then waits, so that a burst of changes such as fast seeks
    // becomes one update
    const publish = Effect.gen(function* () {
      // A new connection has no activity
      let sent = JSON.stringify(null);

      while (true) {
        const changed = yield* SubscriptionRef.changes(activity).pipe(
          Stream.filter((value) => JSON.stringify(value) !== sent),
          Stream.runHead,
        );
        if (Option.isNone(changed)) return;

        yield* setActivity(changed.value);
        sent = JSON.stringify(changed.value);
        yield* Effect.sleep(updateGap);
      }
    });

    yield* Effect.raceFirst(receive, publish).pipe(
      Effect.catch((error) => Effect.logInfo("Lost the connection to Discord", String(error))),
    );
  },
  (effect) => effect.pipe(Effect.scoped),
);

/**
 * Keeps the presence of the Discord desktop client equal to `activity`. Rich Presence on its local
 * socket needs no OAuth. After each new connection, it sends the current activity again.
 */
export const presence = (
  clientId: string,
  activity: SubscriptionRef.SubscriptionRef<Activity | null>,
) =>
  connect(clientId, activity).pipe(
    Effect.tapError((error) => Effect.logDebug("Cannot connect to Discord", String(error))),
    Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])),
    Effect.forever,
  );
