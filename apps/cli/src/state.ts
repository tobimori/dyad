import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { Effect } from "effect";
import { Atom } from "effect/unstable/reactivity";

export const serverDescriptor = (serverUrl: string) =>
  Atom.runtime(serverConnectionLayer(serverUrl)).atom(
    ServerConnection.use((client) => client.describe()).pipe(Effect.timeout("5 seconds")),
  );
