import { ServerRpc } from "@dyad/domain";
import { Context, Layer } from "effect";
import { RpcClient, RpcSerialization } from "effect/unstable/rpc";
import type { RpcClientError } from "effect/unstable/rpc/RpcClientError";
import { Socket } from "effect/unstable/socket";

export class ServerConnection extends Context.Service<
  ServerConnection,
  RpcClient.FromGroup<typeof ServerRpc, RpcClientError>
>()("@dyad/client-runtime/ServerConnection") {}

export const serverConnectionLayer = (baseUrl: string) => {
  const endpoint = new URL("/rpc", baseUrl);
  endpoint.protocol = endpoint.protocol === "https:" ? "wss:" : "ws:";

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
};
