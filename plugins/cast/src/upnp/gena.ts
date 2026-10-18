// @effect-diagnostics-next-line nodeBuiltinImport:off -- GENA uses the `SUBSCRIBE` and `NOTIFY` methods, which `effect/http` 4.0.5 does not allow
import { createServer, request, type IncomingMessage } from "node:http";

import { NodeDatagramSocket } from "@effect/platform-node";
import { Data, Effect, Queue, Ref, Schedule, Schema } from "effect";
import { NetAddress } from "effect/net";

import type { UpnpService } from "../target.ts";
import { decodeXml } from "./xml.ts";

class GenaError extends Data.TaggedError("GenaError")<{ readonly reason: string }> {}

const requestedSeconds = 300;

const SubscribeAnswer = Schema.Struct({
  sid: Schema.String,
  timeout: Schema.optional(Schema.String),
});

const PropertySet = Schema.Struct({
  propertyset: Schema.Struct({
    property: Schema.Array(Schema.Record(Schema.String, Schema.String)),
  }),
});

const Value = Schema.Struct({
  val: Schema.optional(Schema.String),
  channel: Schema.optional(Schema.String),
});

// `InstanceID` has its own `val` attribute next to the variables
const LastChange = Schema.Struct({
  Event: Schema.Struct({
    InstanceID: Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Value, Schema.Array(Value)]),
    ),
  }),
});

const send = (method: "SUBSCRIBE" | "UNSUBSCRIBE", url: string, headers: Record<string, string>) =>
  Effect.callback<IncomingMessage, GenaError>((resume, signal) => {
    const outgoing = request(url, { method, headers, signal, timeout: 5000 }, (response) => {
      response.resume();
      resume(Effect.succeed(response));
    });
    outgoing.on("timeout", () => outgoing.destroy(new Error("No answer")));
    outgoing.on("error", (error) => resume(Effect.fail(new GenaError({ reason: error.message }))));
    outgoing.end();
  });

const subscribe = (url: string, headers: Record<string, string>) =>
  send("SUBSCRIBE", url, { ...headers, TIMEOUT: `Second-${requestedSeconds}` }).pipe(
    Effect.flatMap((response) =>
      response.statusCode === 200
        ? Schema.decodeUnknownEffect(SubscribeAnswer)(response.headers).pipe(
            Effect.mapError(() => new GenaError({ reason: "SUBSCRIBE answer without SID" })),
          )
        : Effect.fail(new GenaError({ reason: `SUBSCRIBE answered ${response.statusCode}` })),
    ),
  );

// `Second-1800`, or `Second-infinite`
const renewAfterSeconds = (timeout: string | undefined) => {
  const seconds = Number(timeout?.replace(/^Second-/i, ""));
  return Number.isFinite(seconds) && seconds > 0 ? seconds / 2 : requestedSeconds / 2;
};

/** The variables of a GENA event. `LastChange` is expanded to its variables. */
const eventVariables = (body: string) =>
  Effect.gen(function* () {
    const variables = new Map<string, string>();
    const properties = yield* decodeXml(PropertySet, body);

    for (const property of properties.propertyset.property) {
      for (const [name, value] of Object.entries(property)) {
        if (name !== "LastChange") {
          variables.set(name, value);
          continue;
        }

        const change = yield* decodeXml(LastChange, value);
        for (const [variable, entry] of Object.entries(change.Event.InstanceID)) {
          if (entry instanceof Array) {
            const master = entry.find((channel) => channel.channel === "Master") ?? entry[0];
            if (master?.val !== undefined) variables.set(variable, master.val);
            continue;
          }
          if (entry instanceof Object && entry.val !== undefined) {
            variables.set(variable, entry.val);
          }
        }
      }
    }

    return variables;
  });

/**
 * The local address of the route to `host`. A connected UDP socket sends nothing; the system
 * picks the address.
 */
export const localAddressTo = (host: string) =>
  Effect.gen(function* () {
    // @effect-diagnostics-next-line experimentalApiUsage:off -- Effect has no stable UDP socket
    const socket = yield* NodeDatagramSocket.make({ connect: { address: host, port: 1900 } });
    const reader = yield* socket.reader;
    return NetAddress.formatUrlHost(reader.address.address);
  }).pipe(Effect.scoped);

/**
 * Subscribes to the events of `services` on `host` and keeps the subscriptions alive. `active`
 * tells whether all subscriptions are active, so that the caller can poll when they are not.
 */
export const subscribeEvents = (
  host: string,
  services: ReadonlyArray<UpnpService>,
  onEvent: (variables: ReadonlyMap<string, string>) => Effect.Effect<void>,
) =>
  Effect.gen(function* () {
    const bodies = yield* Queue.unbounded<string>();
    const active = yield* Ref.make(0);

    const server = yield* Effect.acquireRelease(
      Effect.callback<ReturnType<typeof createServer>, GenaError>((resume) => {
        const listener = createServer((incoming, response) => {
          const chunks: Array<Buffer> = [];
          incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
          incoming.on("end", () => {
            response.writeHead(incoming.method === "NOTIFY" ? 200 : 405).end();
            if (incoming.method === "NOTIFY") {
              Queue.offerUnsafe(bodies, Buffer.concat(chunks).toString("utf8"));
            }
          });
        });
        listener.once("error", (error) =>
          resume(Effect.fail(new GenaError({ reason: error.message }))),
        );
        listener.listen(0, () => resume(Effect.succeed(listener)));
      }),
      (listener) => Effect.sync(() => listener.close()),
    );
    const address = server.address();
    const port = address instanceof Object ? address.port : 0;
    const callback = `http://${yield* localAddressTo(host)}:${port}/`;

    const keepSubscribed = (service: UpnpService) =>
      Effect.gen(function* () {
        const first = yield* subscribe(service.eventUrl, {
          CALLBACK: `<${callback}>`,
          NT: "upnp:event",
        });
        yield* Ref.update(active, (count) => count + 1);
        yield* Effect.addFinalizer(() =>
          Ref.update(active, (count) => count - 1).pipe(
            Effect.andThen(send("UNSUBSCRIBE", service.eventUrl, { SID: first.sid })),
            Effect.ignore,
          ),
        );

        let timeout = first.timeout;
        while (true) {
          yield* Effect.sleep(`${renewAfterSeconds(timeout)} seconds`);
          const renewed = yield* subscribe(service.eventUrl, { SID: first.sid });
          timeout = renewed.timeout;
        }
      }).pipe(
        Effect.scoped,
        Effect.tapError((error) =>
          Effect.logDebug("UPnP event subscription failed", service.eventUrl, error.reason),
        ),
        Effect.retry(Schedule.spaced("30 seconds")),
      );

    yield* Effect.forEach(services, (service) => Effect.forkScoped(keepSubscribed(service)));

    yield* Queue.take(bodies).pipe(
      Effect.flatMap(eventVariables),
      Effect.flatMap(onEvent),
      Effect.catchTag("XmlError", (error) =>
        Effect.logDebug("Ignored an unexpected UPnP event", error.reason),
      ),
      Effect.forever,
      Effect.forkScoped,
    );

    return { active: Ref.get(active).pipe(Effect.map((count) => count === services.length)) };
  });
