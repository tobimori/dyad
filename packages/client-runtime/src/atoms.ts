import type { AlbumRef, ArtistRef } from "@dyad/domain";
import { Context, Effect, Layer, Option, Stream } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";

import { ConnectionStatus, ServerConnection } from "./connection.ts";
import { ClientDatabase, accountProvidersState } from "./replica/database.ts";
import { catalogTables } from "./replica/rows.ts";
import {
  localLibrary,
  localPlaylistEntries,
  localPlaylists,
  localRecentPlays,
  localSourceSegments,
  localSyncProgress,
} from "./replica/views.ts";

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

/**
 * The atoms use the connection of `services`, which the session client shares. Library, playlist
 * and play views read the client replica and run again after it commits to their tables. `logging`
 * sends their logs to the client's logger.
 */
export const serverAtoms = (
  services: Context.Context<
    ServerConnection | ConnectionStatus | ClientDatabase | Reactivity.Reactivity
  >,
  logging: Layer.Layer<never>,
) => {
  const runtime = Atom.runtime(Layer.succeedContext(services).pipe(Layer.provideMerge(logging)));
  const reactivity = Context.get(services, Reactivity.Reactivity);
  const local = <A, E>(tables: ReadonlyArray<string>, query: Effect.Effect<A, E, ClientDatabase>) =>
    runtime.atom(reactivity.stream(tables, query));

  const librarySyncStatus = runtime.atom(Stream.unwrap(ServerConnection.useSync(pollSyncStatus)));

  return {
    connection: runtime.atom(ServerConnection),
    // `Atom` 4.0.5 calls an argument that is a function, and a service key is a class
    status: runtime.subscriptionRef(() => Effect.service(ConnectionStatus)),
    sources: runtime.atom(
      ServerConnection.use((client) => client.listSources()).pipe(Effect.timeout("5 seconds")),
    ),
    library: local(["library_item", ...catalogTables, "client_state"], localLibrary),
    playlists: local(["playlist", "playlist_entry"], localPlaylists),
    playlistEntries: Atom.family((playlistId: string) =>
      local(
        ["playlist", "playlist_entry", ...catalogTables, "client_state"],
        localPlaylistEntries(playlistId),
      ).pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
    /** Which scopes are still "Syncing" */
    syncProgress: local(["sync_scope"], localSyncProgress),
    librarySyncStatus,
    providerNames: local(
      ["client_state"],
      Effect.map(
        accountProvidersState.get,
        (providers) =>
          new Map(
            Option.match(providers, {
              onNone: () => [],
              onSome: (value) => Object.entries(value.names),
            }),
          ),
      ),
    ),
    /** The linked providers that can create a playlist for a two-way link, with their names */
    playlistProviders: local(
      ["client_state"],
      Effect.map(accountProvidersState.get, (providers) =>
        Option.match(providers, {
          onNone: () => [],
          onSome: (value) =>
            value.createPlaylists.flatMap((provider) =>
              value.linked.includes(provider)
                ? [{ provider, name: value.names[provider] ?? provider }]
                : [],
            ),
        }),
      ),
    ),
    recentPlays: local(["play_event", ...catalogTables, "client_state"], localRecentPlays),
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
    /** The tracklist of a DJ set source from the server, else from the replica */
    sourceSegments: Atom.family((sourceId: string) => {
      const remote = runtime.atom(
        Stream.unwrap(ServerConnection.useSync((client) => client.sourceSegments({ sourceId }))),
      );
      const replica = local(["source_segment"], localSourceSegments(sourceId));
      return Atom.make((get) => {
        const online = get(remote);
        return AsyncResult.isSuccess(online) ? online : get(replica);
      }).pipe(Atom.setIdleTTL(pageIdleTime));
    }),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
