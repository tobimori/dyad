import { ConnectionStatus, ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { Effect, Layer, Option } from "effect";
import type { Redacted } from "effect";
import { Atom } from "effect/reactivity";

/** `logging` sends the logs of the connection to the log file, not to the terminal */
export const serverAtoms = (
  serverUrl: string,
  deviceToken: Redacted.Redacted<string>,
  logging: Layer.Layer<never>,
) => {
  const runtime = Atom.runtime(
    serverConnectionLayer(serverUrl, Option.some(deviceToken)).pipe(Layer.provideMerge(logging)),
  );

  return {
    connection: runtime.atom(ServerConnection),
    // `Atom` 4.0.5 calls an argument that is a function, and a service key is a class
    status: runtime.subscriptionRef(() => Effect.service(ConnectionStatus)),
    sources: runtime.atom(
      ServerConnection.use((client) => client.listSources()).pipe(Effect.timeout("5 seconds")),
    ),
    recentPlays: runtime.atom(
      ServerConnection.use((client) => client.listRecentPlays()).pipe(Effect.timeout("5 seconds")),
    ),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
