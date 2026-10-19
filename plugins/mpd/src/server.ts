import { NodeSocket, NodeSocketServer } from "@effect/platform-node";
import {
  Clock,
  Data,
  Effect,
  Option,
  Predicate,
  Queue,
  Ref,
  Result,
  Scope,
  Stream,
  SubscriptionRef,
} from "effect";
import type { Cause, Redacted } from "effect";
import { NetAddress } from "effect/net";
import { Socket } from "effect/socket";

import { Connection, openCommands, Server, sessionCommands } from "./commands.ts";
import type { SessionMirror } from "./mirror.ts";
import { Ack, ackCode, field, parseLine, tags } from "./protocol.ts";
import type { Response } from "./protocol.ts";
import { openSession, Session } from "./session.ts";

/**
 * Opens the session of the user whose device token is `password`, for the lifetime of the scope.
 * `None` when no device has this token.
 */
export type Login = (
  password: Redacted.Redacted<string>,
) => Effect.Effect<Option.Option<SessionMirror["Service"]>, never, Scope.Scope>;

// MPD sends passwords in plain text, so the server accepts only peers on private networks
const isPrivatePeer = (host: string) => {
  const parsed = NetAddress.ipFromString(host);
  if (Result.isFailure(parsed)) return false;
  const address = NetAddress.isIpv6Address(parsed.success)
    ? Option.getOrElse(NetAddress.fromIpv4Mapped(parsed.success), () => parsed.success)
    : parsed.success;
  if (NetAddress.isLoopback(address) || NetAddress.isLinkLocal(address)) return true;
  if (NetAddress.isIpv6Address(address)) return NetAddress.isUniqueLocal(address);
  const [first, second = 0] = NetAddress.ipv4ToOctets(address);
  // Tailscale uses 100.64.0.0/10
  return NetAddress.isPrivate(address) || (first === 100 && (second & 0xc0) === 64);
};

const maxConnectionsPerPeer = 20;

const subsystems = new Set([
  "database",
  "update",
  "stored_playlist",
  "playlist",
  "player",
  "mixer",
  "output",
  "options",
  "partition",
  "sticker",
  "subscription",
  "message",
  "neighbor",
  "mount",
]);

const encoder = new TextEncoder();
const newline = encoder.encode("\n");

const encode = (response: Response) => {
  const chunks = response.flatMap((part) =>
    Predicate.isString(part) ? [encoder.encode(`${part}\n`)] : [part, newline],
  );
  const bytes = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
};

class Rejected extends Data.TaggedError("Rejected")<{
  readonly command: string;
  readonly ack: Ack;
}> {}

const execute = Effect.fnUntraced(function* (line: string, connection: Connection) {
  const { name, args } = yield* parseLine(line).pipe(
    Effect.mapError((ack) => new Rejected({ command: "", ack })),
  );
  const open = openCommands.get(name);
  const handler = open ?? sessionCommands.get(name);
  if (handler === undefined) {
    const ack = new Ack({ code: ackCode.unknown, message: `unknown command "${name}"` });
    return yield* new Rejected({ command: "", ack });
  }
  const reject = (ack: Ack) => new Rejected({ command: name, ack });
  if (args.length < handler.min || args.length > handler.max) {
    const problem =
      handler.min === handler.max
        ? "wrong number of arguments"
        : `too ${args.length < handler.min ? "few" : "many"} arguments`;
    return yield* reject(new Ack({ code: ackCode.argument, message: `${problem} for "${name}"` }));
  }
  if (open !== undefined) return yield* open.run(args, connection).pipe(Effect.mapError(reject));

  const session = yield* Ref.get(connection.session);
  if (Option.isNone(session)) {
    const message = `you don't have permission for "${name}"`;
    return yield* reject(new Ack({ code: ackCode.permission, message }));
  }
  return yield* handler
    .run(args, connection)
    .pipe(Effect.provideService(Session, session.value), Effect.mapError(reject));
});

// Runs the lines of one command or of one command list, and stops at the first error
const runList = Effect.fnUntraced(function* (
  lines: ReadonlyArray<string>,
  listOk: boolean,
  connection: Connection,
) {
  const response: Array<string | Uint8Array> = [];
  for (const [index, line] of lines.entries()) {
    const result = yield* Effect.result(execute(line, connection));
    if (Result.isFailure(result)) {
      const { command, ack } = result.failure;
      response.push(`ACK [${ack.code}@${index}] {${command}} ${ack.message}`);
      return response;
    }
    response.push(...result.success);
    if (listOk) response.push("list_OK");
  }
  response.push("OK");
  return response;
});

const handleConnection = Effect.fnUntraced(function* (
  socket: Socket.Socket,
  server: Server,
  login: Login,
  peers: Map<string, number>,
) {
  // The reader opens the socket, and the scope closes it
  const pull = yield* Socket.readerBytes(socket);
  // `SocketServer.run` provides the Node socket of each connection
  const netSocket = yield* Effect.serviceOption(NodeSocket.NetSocket);
  const peer = Option.match(netSocket, {
    onNone: () => "",
    onSome: (net) => net.remoteAddress ?? "",
  });
  const peerConnections = peers.get(peer) ?? 0;
  if (!isPrivatePeer(peer) || peerConnections >= maxConnectionsPerPeer) return;
  peers.set(peer, peerConnections + 1);
  yield* Effect.addFinalizer(() => Effect.sync(() => peers.set(peer, (peers.get(peer) ?? 1) - 1)));

  const scope = yield* Scope.Scope;
  const writer = yield* socket.writer;
  const send = (response: Response) => writer.write(encode(response));

  const lines = yield* Queue.bounded<string, Cause.Done>(64);
  yield* Effect.gen(function* () {
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      for (const chunk of yield* pull) buffer += decoder.decode(chunk, { stream: true });
      const complete = buffer.split("\n");
      buffer = complete.pop() ?? "";
      for (const line of complete) yield* Queue.offer(lines, line);
    }
  }).pipe(Effect.ignore, Effect.ensuring(Queue.end(lines)), Effect.forkScoped);

  const session = yield* Ref.make(Option.none<Session["Service"]>());
  const connection = new Connection({
    server,
    session,
    authenticate: (password) =>
      Effect.gen(function* () {
        const mirror = yield* login(password).pipe(Scope.provide(scope));
        if (Option.isNone(mirror)) return false;
        const opened = yield* openSession(mirror.value).pipe(Scope.provide(scope));
        yield* Ref.set(session, Option.some(opened));
        return true;
      }),
    enabledTags: new Set(tags),
    binaryLimit: yield* Ref.make(8192),
    artwork: new Map(),
  });

  // Answers when a wanted subsystem changes or at `noidle`. `false` closes the connection.
  const idle = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
    const current = yield* Ref.get(session);
    if (Option.isNone(current)) {
      yield* send([`ACK [${ackCode.permission}@0] {idle} you don't have permission for "idle"`]);
      return true;
    }
    const unknown = args.find((arg) => !subsystems.has(arg));
    if (unknown !== undefined) {
      yield* send([`ACK [${ackCode.argument}@0] {idle} Unrecognized idle event: ${unknown}`]);
      return true;
    }
    const { changed: pending } = current.value;
    const wanted = (subsystem: string) => args.length === 0 || args.includes(subsystem);
    const changed = SubscriptionRef.changes(pending).pipe(
      Stream.filter((changed) => [...changed].some(wanted)),
      Stream.runHead,
    );
    const answer = yield* Effect.raceFirst(
      Effect.as(changed, true),
      // MPD closes a connection that sends another command during `idle`
      Queue.take(lines).pipe(
        Effect.map((line) => line === "noidle"),
        Effect.orElseSucceed(() => false),
      ),
    );
    if (!answer) return false;

    const reported = yield* SubscriptionRef.modify(pending, (changed) => [
      [...changed].filter(wanted),
      new Set([...changed].filter((subsystem) => !wanted(subsystem))),
    ]);
    yield* send([...reported.map((subsystem) => field("changed", subsystem)), "OK"]);
    return true;
  });

  // The server closes a connection that sends nothing for 60 seconds, except during `idle`
  const nextLine = Queue.take(lines).pipe(
    Effect.timeoutOption("60 seconds"),
    Effect.orElseSucceed(() => Option.none<string>()),
  );

  yield* send(["OK MPD 0.23.0"]);
  while (true) {
    const line = yield* nextLine;
    if (Option.isNone(line)) return;
    const command = yield* Effect.option(parseLine(line.value));
    const name = Option.match(command, { onNone: () => "", onSome: ({ name }) => name });

    if (name === "close") return;
    // ncmpcpp sends `noidle` after each `idle` answer, when the server is not idle
    if (name === "noidle") continue;
    if (name === "idle") {
      const args = Option.match(command, { onNone: () => [], onSome: ({ args }) => args });
      if (!(yield* idle(args))) return;
      continue;
    }
    if (name !== "command_list_begin" && name !== "command_list_ok_begin") {
      yield* send(yield* runList([line.value], false, connection));
      continue;
    }

    const batch: Array<string> = [];
    while (true) {
      const next = yield* nextLine;
      if (Option.isNone(next)) return;
      if (next.value === "command_list_end") break;
      batch.push(next.value);
    }
    yield* send(yield* runList(batch, name === "command_list_ok_begin", connection));
  }
});

/** Serves the MPD protocol 0.23 for the sessions that `login` opens */
export const serve = Effect.fn("serve")(function* (
  listen: { readonly host: string; readonly port: number },
  login: Login,
) {
  const socketServer = yield* NodeSocketServer.make(listen);
  const server = new Server({
    startedAt: yield* Clock.currentTimeMillis,
    outputNumbers: new Map(),
    artistRefsByName: new Map(),
  });
  const peers = new Map<string, number>();
  yield* Effect.logInfo(`MPD server listens on ${listen.host}:${listen.port}`);
  return yield* socketServer.run((socket) =>
    handleConnection(socket, server, login, peers).pipe(Effect.scoped, Effect.ignore),
  );
});
