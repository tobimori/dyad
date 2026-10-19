import { NodeSocket } from "@effect/platform-node";
import { Data, Deferred, Effect, Option, Schedule, Schema } from "effect";
import { Socket } from "effect/socket";

import { TargetUnreachable } from "../target.ts";
import type { CastDevice } from "../target.ts";

export const namespaces = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
};

export const receiverId = "receiver-0";
const senderId = "sender-dyad";

/** `CastMessage` from `cast_channel.proto`, with a UTF-8 payload */
const CastMessage = Schema.Struct({
  sourceId: Schema.String,
  destinationId: Schema.String,
  namespace: Schema.String,
  payloadUtf8: Schema.String,
});

const Envelope = Schema.fromJsonString(
  Schema.Struct({ type: Schema.String, requestId: Schema.optional(Schema.Finite) }),
);

/** A JSON message from the receiver. `payload` is the JSON text, for a schema of its `type`. */
export class CastEvent extends Data.Class<{
  readonly namespace: string;
  readonly type: string;
  readonly payload: string;
}> {}

class ProtobufError extends Data.TaggedError("ProtobufError")<{}> {}

const varint = (value: number) => {
  const bytes: Array<number> = [];
  let rest = value;
  while (rest > 0x7f) {
    bytes.push((rest & 0x7f) | 0x80);
    rest >>>= 7;
  }
  bytes.push(rest);
  return bytes;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const encodeMessage = (destinationId: string, namespace: string, payload: string) => {
  const stringField = (field: number, value: string) => {
    const bytes = encoder.encode(value);
    return [...varint((field << 3) | 2), ...varint(bytes.length), ...bytes];
  };
  const body = [
    // protocol_version = CASTV2_1_0
    0x08,
    0,
    ...stringField(2, senderId),
    ...stringField(3, destinationId),
    ...stringField(4, namespace),
    // payload_type = STRING
    0x28,
    0,
    ...stringField(6, payload),
  ];

  const frame = new Uint8Array(4 + body.length);
  new DataView(frame.buffer).setUint32(0, body.length);
  frame.set(body, 4);
  return frame;
};

// Reads the length-delimited fields, which hold all strings of `CastMessage`
const decodeMessage = Effect.fnUntraced(function* (bytes: Uint8Array) {
  const strings = new Map<number, string>();
  let offset = 0;

  const readVarint = () => {
    let value = 0;
    let shift = 0;
    while (offset < bytes.length) {
      const byte = bytes[offset] ?? 0;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
    return value;
  };

  while (offset < bytes.length) {
    const key = readVarint();
    const wireType = key & 7;
    if (wireType === 0) {
      readVarint();
      continue;
    }
    if (wireType !== 2) return yield* new ProtobufError();

    const length = readVarint();
    strings.set(key >>> 3, decoder.decode(bytes.subarray(offset, offset + length)));
    offset += length;
  }

  return yield* Schema.decodeUnknownEffect(CastMessage)({
    sourceId: strings.get(2),
    destinationId: strings.get(3),
    namespace: strings.get(4),
    payloadUtf8: strings.get(6),
  });
});

// One read can hold part of a frame or more than one frame
const frameReader = (pull: Effect.Effect<ReadonlyArray<Uint8Array>, Socket.SocketError>) => {
  let buffer = new Uint8Array(0);

  const take = () => {
    if (buffer.length < 4) return undefined;

    const length = new DataView(buffer.buffer, buffer.byteOffset).getUint32(0);
    if (buffer.length < 4 + length) return undefined;

    const frame = buffer.subarray(4, 4 + length);
    buffer = buffer.subarray(4 + length);
    return frame;
  };

  return Effect.gen(function* () {
    while (true) {
      const frame = take();
      if (frame !== undefined) return frame;

      const chunks = [buffer, ...(yield* pull)];
      const next = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.length, 0));
      let offset = 0;
      for (const chunk of chunks) {
        next.set(chunk, offset);
        offset += chunk.length;
      }
      buffer = next;
    }
  });
};

/** A CASTV2 connection to a Cast device */
export class CastChannel extends Data.Class<{
  /** Sends `payload` with a new `requestId` and waits for the answer with that ID */
  readonly request: (
    namespace: string,
    destinationId: string,
    payload: Schema.JsonObject,
  ) => Effect.Effect<CastEvent, TargetUnreachable>;
  /** Opens a virtual connection to a receiver app. Status messages of the app need it. */
  readonly connect: (destinationId: string) => Effect.Effect<void, TargetUnreachable>;
  /** Fails when the connection ends */
  readonly closed: Effect.Effect<never, TargetUnreachable>;
}> {}

/**
 * Opens a CASTV2 connection and calls `onEvent` for each JSON message. The receiver closes a
 * connection without a `PING` for some seconds, and this side closes it when the receiver is quiet.
 */
export const openChannel = Effect.fn("openChannel")(function* (
  device: CastDevice,
  onEvent: (event: CastEvent) => Effect.Effect<void>,
) {
  const unreachable = (reason: string) => new TargetUnreachable({ device: device.name, reason });

  // Cast devices use a self-signed certificate. Device authentication is not needed to play.
  const socket = yield* NodeSocket.makeTls({
    host: device.host,
    port: device.port,
    rejectUnauthorized: false,
    openTimeout: "5 seconds",
  });
  // `SocketOpenError` says only "An error occurred during Open". Its cause names the reason.
  const pull = yield* Socket.readerBytes(socket).pipe(
    Effect.mapError(({ reason }) =>
      unreachable(
        "cause" in reason && reason.cause instanceof Error ? reason.cause.message : reason.message,
      ),
    ),
  );
  const writer = yield* socket.writer;
  const nextFrame = frameReader(pull);

  const pending = new Map<number, Deferred.Deferred<CastEvent>>();
  const closed = yield* Deferred.make<never, TargetUnreachable>();
  let lastRequestId = 0;

  const send = (namespace: string, destinationId: string, payload: Schema.JsonObject) =>
    writer
      .write(encodeMessage(destinationId, namespace, JSON.stringify(payload)))
      .pipe(Effect.mapError((error) => unreachable(error.message)));

  const request = Effect.fnUntraced(function* (
    namespace: string,
    destinationId: string,
    payload: Schema.JsonObject,
  ) {
    lastRequestId += 1;
    const requestId = lastRequestId;
    const answer = yield* Deferred.make<CastEvent>();
    pending.set(requestId, answer);

    return yield* send(namespace, destinationId, { ...payload, requestId }).pipe(
      Effect.andThen(Deferred.await(answer)),
      Effect.raceFirst(Deferred.await(closed)),
      Effect.timeoutOrElse({
        duration: "10 seconds",
        orElse: () => Effect.fail(unreachable(`No answer to ${String(payload.type)}`)),
      }),
      Effect.ensuring(Effect.sync(() => pending.delete(requestId))),
    );
  });

  const receive = Effect.gen(function* () {
    while (true) {
      const frame = yield* nextFrame.pipe(
        Effect.mapError(() => unreachable("The connection closed")),
        Effect.timeoutOrElse({
          duration: "20 seconds",
          orElse: () => Effect.fail(unreachable("The device stopped answering")),
        }),
      );
      const message = yield* decodeMessage(frame).pipe(Effect.option);
      if (Option.isNone(message)) continue;

      const { namespace, sourceId, payloadUtf8 } = message.value;
      const envelope = yield* Schema.decodeEffect(Envelope)(payloadUtf8).pipe(Effect.option);
      if (Option.isNone(envelope)) continue;

      const { type, requestId } = envelope.value;
      if (namespace === namespaces.heartbeat && type === "PING") {
        yield* send(namespaces.heartbeat, sourceId, { type: "PONG" });
        continue;
      }

      const event = new CastEvent({ namespace, type, payload: payloadUtf8 });
      yield* onEvent(event);

      const answer = requestId === undefined ? undefined : pending.get(requestId);
      if (answer !== undefined) yield* Deferred.succeed(answer, event);
    }
  }).pipe(Effect.catch((error) => Deferred.fail(closed, error)));
  yield* Effect.forkScoped(receive);

  const connect = (destinationId: string) =>
    send(namespaces.connection, destinationId, { type: "CONNECT" });

  yield* connect(receiverId);
  yield* send(namespaces.heartbeat, receiverId, { type: "PING" }).pipe(
    Effect.repeat(Schedule.spaced("5 seconds")),
    Effect.catch((error) => Deferred.fail(closed, error)),
    Effect.forkScoped,
  );

  return new CastChannel({ request, connect, closed: Deferred.await(closed) });
});
