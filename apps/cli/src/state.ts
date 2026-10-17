import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { Effect } from "effect";
import type { Option, Redacted } from "effect";
import { Atom } from "effect/reactivity";

export const serverAtoms = (
  serverUrl: string,
  deviceToken: Option.Option<Redacted.Redacted<string>>,
) => {
  const runtime = Atom.runtime(serverConnectionLayer(serverUrl, deviceToken));
  return {
    connection: runtime.atom(ServerConnection),
    server: runtime.atom(
      ServerConnection.use((client) => client.describe()).pipe(Effect.timeout("5 seconds")),
    ),
    sources: runtime.atom(
      ServerConnection.use((client) => client.listSources()).pipe(Effect.timeout("5 seconds")),
    ),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
