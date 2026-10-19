import { Unauthorized } from "@dyad/domain";
import type { ServerRpc } from "@dyad/domain";
import { Context, Effect, Option, Schema, Stream } from "effect";
import type { RpcClient } from "effect/rpc";
import { RpcClientError } from "effect/rpc/RpcClientError";

type HomeClient = RpcClient.FromGroup<typeof ServerRpc, RpcClientError>;

// A home server that no longer accepts this replica is as good as offline
const lost = "Cannot reach the home server";

/**
 * On the replica of a device, the connection to its home server. The device asks it for the calls
 * that need providers and leaves the catalog jobs to it. `None` on the home server.
 */
export class HomeServer extends Context.Service<HomeServer, Option.Option<HomeClient>>()(
  "@dyad/server-core/HomeServer",
) {}

/** The answer of the home server on a device; the local answer on the home server */
export const forwardEffect = <A, E, R>(
  remote: (home: HomeClient) => Effect.Effect<A, NoInfer<E> | RpcClientError | Unauthorized>,
  local: Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const home = yield* HomeServer;
    if (Option.isNone(home)) return yield* local;
    return yield* remote(home.value).pipe(
      Effect.catch((error) =>
        Schema.is(RpcClientError)(error) || Schema.is(Unauthorized)(error)
          ? Effect.die(lost)
          : Effect.fail(error),
      ),
    );
  });

/** Like `forwardEffect`; `offline` answers on a device that cannot reach its home server */
export const forwardStream = <A, E, R>(
  remote: (home: HomeClient) => Stream.Stream<A, NoInfer<E> | RpcClientError | Unauthorized>,
  local: Stream.Stream<A, E, R>,
  offline?: Stream.Stream<A, E, NoInfer<R>>,
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const home = yield* HomeServer;
      // RETURN TYPE: the branches have different error types before the catch
      const stream: Stream.Stream<A, E, R> = Option.isNone(home)
        ? local
        : remote(home.value).pipe(
            Stream.catch((error) =>
              Schema.is(RpcClientError)(error) || Schema.is(Unauthorized)(error)
                ? (offline ?? Stream.die(lost))
                : Stream.fail(error),
            ),
          );
      return stream;
    }),
  );
