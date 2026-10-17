import { Authentication, HttpUrl, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer, Option, Redacted, Schema, SubscriptionRef, pipe } from "effect";
import { Headers, Url } from "effect/http";
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { Socket } from "effect/socket";

export class ServerConnection extends Context.Service<
  ServerConnection,
  RpcClient.FromGroup<typeof ServerRpc, RpcClientError>
>()("@dyad/client-runtime/ServerConnection") {}

/**
 * The state of the socket to the server. The client opens the socket again after it drops, so a
 * call fails at once while the state is not `connected`.
 */
export class ConnectionStatus extends Context.Service<
  ConnectionStatus,
  SubscriptionRef.SubscriptionRef<"connecting" | "connected" | "reconnecting">
>()("@dyad/client-runtime/ConnectionStatus") {}

const connectionStatusLayer = Layer.effect(
  ConnectionStatus,
  SubscriptionRef.make<"connecting" | "connected" | "reconnecting">("connecting"),
);

// `RpcClient` 4.0.5 also runs `onDisconnect` after a failed attempt to open the socket, so the
// state becomes `reconnecting` only after a connection that opened
const connectionHooksLayer = Layer.effect(
  RpcClient.ConnectionHooks,
  Effect.gen(function* () {
    const status = yield* ConnectionStatus;
    return {
      onConnect: SubscriptionRef.set(status, "connected"),
      onDisconnect: SubscriptionRef.update(status, (current) =>
        current === "connecting" ? "connecting" : "reconnecting",
      ),
    };
  }),
);

/** Without a device token, only the public calls such as `describe` and `login` succeed */
export const serverConnectionLayer = (
  baseUrl: string,
  deviceToken: Option.Option<Redacted.Redacted<string>>,
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const url = yield* Schema.decodeEffect(HttpUrl)(baseUrl);
      const endpoint = pipe(
        url,
        Url.setPathname("/rpc"),
        Url.setSearch(""),
        Url.setHash(""),
        Url.setProtocol(url.protocol === "https:" ? "wss:" : "ws:"),
      );

      const authentication = RpcMiddleware.layerClient(Authentication, ({ request, next }) =>
        Option.match(deviceToken, {
          onNone: () => next(request),
          onSome: (token) =>
            next({
              ...request,
              headers: Headers.set(
                request.headers,
                "authorization",
                `Bearer ${Redacted.value(token)}`,
              ),
            }),
        }),
      );

      const protocol = RpcClient.layerProtocolSocket().pipe(
        Layer.provide(RpcSerialization.layerJson),
        Layer.provide(connectionHooksLayer),
        Layer.provide(
          Socket.layerWebSocket(endpoint.href).pipe(
            Layer.provide(Socket.layerWebSocketConstructorGlobal),
          ),
        ),
      );

      return Layer.effect(ServerConnection, RpcClient.make(ServerRpc)).pipe(
        Layer.provide(authentication),
        Layer.provide(protocol),
        Layer.provideMerge(connectionStatusLayer),
      );
    }),
  );
