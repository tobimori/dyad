import type { AlbumRef, ArtistRef } from "@dyad/domain";
import { Effect, Layer, Option, Stream } from "effect";
import type { Redacted } from "effect";
import { Atom } from "effect/reactivity";

import { ConnectionStatus, ServerConnection, serverConnectionLayer } from "./connection.ts";

// Idle pages keep their last emission this long, so back navigation is instant
const pageIdleTime = "5 minutes";

/** `logging` sends the connection logs to the client's logger */
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
    libraryArtists: runtime.atom(
      ServerConnection.use((client) => client.listLibraryArtists()).pipe(
        Effect.timeout("5 seconds"),
      ),
    ),
    libraryAlbums: runtime.atom(
      ServerConnection.use((client) => client.listLibraryAlbums()).pipe(
        Effect.timeout("5 seconds"),
      ),
    ),
    artistPage: Atom.family((ref: ArtistRef) =>
      runtime
        .atom(Stream.unwrap(ServerConnection.useSync((client) => client.artistPage({ ref }))))
        .pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
    albumPage: Atom.family((ref: AlbumRef) =>
      runtime
        .atom(Stream.unwrap(ServerConnection.useSync((client) => client.albumPage({ ref }))))
        .pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
