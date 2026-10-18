import type { AlbumRef, ArtistRef, LibrarySyncStatus } from "@dyad/domain";
import { Effect, Layer, Option, Stream } from "effect";
import type { Context } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { ConnectionStatus, ServerConnection } from "./connection.ts";

// Idle pages keep their last emission this long, so back navigation is instant
const pageIdleTime = "5 minutes";

// The server imports provider libraries in the background, so the client polls the cheap status
const pollSyncStatus = (client: typeof ServerConnection.Service) =>
  Stream.paginate(0, (waitMs: number) =>
    Effect.sleep(waitMs).pipe(
      Effect.andThen(client.getLibrarySyncStatus()),
      Effect.map((statuses) => {
        const next = statuses.some((status) => status.running) ? 5000 : 60_000;
        return [[statuses], Option.some(next)] as const;
      }),
      // A failed poll, for example while the connection is down, keeps the last status
      Effect.orElseSucceed(() => [[], Option.some(60_000)] as const),
    ),
  );

// Changes when a run applies songs or ends, but not at each poll
const syncVersion = (statuses: ReadonlyArray<LibrarySyncStatus>) =>
  statuses
    .map((status) =>
      [
        status.provider,
        status.status,
        status.itemCount,
        status.notPlayableCount,
        status.lastCompleteAt,
        status.nextRunAt,
      ].join(":"),
    )
    .join(" ");

/**
 * The atoms use the connection of `services`, which the session client shares. `logging` sends
 * their logs to the client's logger.
 */
export const serverAtoms = (
  services: Context.Context<ServerConnection | ConnectionStatus>,
  logging: Layer.Layer<never>,
) => {
  const runtime = Atom.runtime(Layer.succeedContext(services).pipe(Layer.provideMerge(logging)));

  const librarySyncStatus = runtime.atom(Stream.unwrap(ServerConnection.useSync(pollSyncStatus)));
  const refreshOnSync = Atom.makeRefreshOnSignal(
    Atom.map(librarySyncStatus, (result) =>
      AsyncResult.isSuccess(result) ? syncVersion(result.value) : "",
    ),
  );

  return {
    connection: runtime.atom(ServerConnection),
    // `Atom` 4.0.5 calls an argument that is a function, and a service key is a class
    status: runtime.subscriptionRef(() => Effect.service(ConnectionStatus)),
    sources: runtime.atom(
      ServerConnection.use((client) => client.listSources()).pipe(Effect.timeout("5 seconds")),
    ),
    library: runtime
      .atom(
        ServerConnection.use((client) => client.listLibrary()).pipe(Effect.timeout("5 seconds")),
      )
      .pipe(refreshOnSync),
    playlists: runtime
      .atom(
        ServerConnection.use((client) => client.listPlaylists()).pipe(Effect.timeout("5 seconds")),
      )
      .pipe(refreshOnSync),
    playlistEntries: Atom.family((playlistId: string) =>
      runtime
        .atom(
          ServerConnection.use((client) => client.listPlaylistEntries({ playlistId })).pipe(
            Effect.timeout("5 seconds"),
          ),
        )
        .pipe(refreshOnSync, Atom.setIdleTTL(pageIdleTime)),
    ),
    librarySyncStatus,
    providerNames: runtime.atom(
      ServerConnection.use((client) => client.listAccountProviders()).pipe(
        Effect.map(
          (providers) =>
            new Map(providers.map((provider) => [provider.provider, provider.name] as const)),
        ),
        Effect.timeout("5 seconds"),
      ),
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
    homePage: runtime.atom(Stream.unwrap(ServerConnection.useSync((client) => client.homePage()))),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
