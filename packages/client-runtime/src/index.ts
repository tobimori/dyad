import { HttpUrl, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer, Schema, pipe } from "effect";
import { Url } from "effect/unstable/http";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Socket } from "effect/unstable/socket";

export class ServerConnection extends Context.Service<
  ServerConnection,
  RpcClient.FromGroup<typeof ServerRpc, RpcClientError>
>()("@dyad/client-runtime/ServerConnection") {}

export const serverConnectionLayer = (baseUrl: string) =>
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

      return Layer.effect(ServerConnection, RpcClient.make(ServerRpc)).pipe(
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
