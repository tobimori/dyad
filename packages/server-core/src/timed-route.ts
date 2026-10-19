import { TimedClientMessage, TimedServerMessage } from "@dyad/domain";
import { Clock, Deferred, Effect, Option, Schema } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { principalOf } from "./auth.ts";
import { Receivers, TimedClient } from "./receivers.ts";

const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(TimedClientMessage));
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(TimedServerMessage));

const nowUs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1000n));

const serve = Effect.fn(function* (socket: Socket.Socket) {
  const receivers = yield* Receivers;
  const reader = yield* socket.reader;
  const writer = yield* socket.writer;
  const send = (data: string | Uint8Array) => writer.write(data).pipe(Effect.ignore);

  const [first, ...rest] = yield* reader.pull.pipe(Effect.timeout("10 seconds"));
  const hello =
    first === undefined || first instanceof Uint8Array ? Option.none() : decodeMessage(first);
  if (Option.isNone(hello) || !TimedClientMessage.guards.Hello(hello.value)) return;
  const principal = yield* principalOf(hello.value.token);

  const client = new TimedClient({
    deviceId: principal.deviceId,
    receiver: hello.value.receiver,
    send,
    closed: yield* Deferred.make<void>(),
  });
  yield* receivers.add(client);

  const receive = Effect.fn(function* (data: string | Uint8Array) {
    const receivedUs = yield* nowUs;
    const message = data instanceof Uint8Array ? Option.none() : decodeMessage(data);
    if (Option.isNone(message)) return;
    if (TimedClientMessage.guards.Listen(message.value)) {
      return yield* receivers.listen(client, message.value.on);
    }
    if (!TimedClientMessage.guards.Probe(message.value)) return;
    const answer = TimedServerMessage.cases.Probe.make({
      clientUs: message.value.clientUs,
      receivedUs,
      sentUs: yield* nowUs,
    });
    yield* send(encodeMessage(answer));
  });

  yield* Effect.forEach(rest, receive, { discard: true });
  for (;;) yield* Effect.forEach(yield* reader.pull, receive, { discard: true });
});

/** Clock probes and PCM for Dyad clients that play in groups or show a visualizer */
export const timedRoute = HttpRouter.add(
  "GET",
  "/timed",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* Effect.orDie(request.upgrade);
    yield* serve(socket).pipe(Effect.scoped, Effect.ignore);
    return HttpServerResponse.empty();
  }),
);
