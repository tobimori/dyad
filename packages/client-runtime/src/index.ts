import { Authentication, HttpUrl, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer, Option, Redacted, Schema, pipe } from "effect";
import { Headers, Url } from "effect/http";
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc";
import type { RpcClientError } from "effect/rpc/RpcClientError";
import { Socket } from "effect/socket";

export class ServerConnection extends Context.Service<
  ServerConnection,
  RpcClient.FromGroup<typeof ServerRpc, RpcClientError>
>()("@dyad/client-runtime/ServerConnection") {}

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

      return Layer.effect(ServerConnection, RpcClient.make(ServerRpc)).pipe(
        Layer.provide(authentication),
        Layer.provide(
          RpcClient.layerProtocolSocket().pipe(
            Layer.provide(RpcSerialization.layerJson),
            Layer.provide(
              Socket.layerWebSocket(endpoint.href).pipe(
                Layer.provide(Socket.layerWebSocketConstructorGlobal),
              ),
            ),
          ),
        ),
      );
    }),
  );
