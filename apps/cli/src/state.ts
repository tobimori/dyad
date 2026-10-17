import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { Effect } from "effect";
import { Atom } from "effect/reactivity";

export const serverAtoms = (serverUrl: string) => {
  const runtime = Atom.runtime(serverConnectionLayer(serverUrl));
  return {
    server: runtime.atom(
      ServerConnection.use((client) => client.describe()).pipe(Effect.timeout("5 seconds")),
    ),
    sources: runtime.atom(
      ServerConnection.use((client) => client.listSources()).pipe(Effect.timeout("5 seconds")),
    ),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
