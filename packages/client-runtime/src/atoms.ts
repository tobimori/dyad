import { AlbumPage, ArtistPage, PageNotFound, PageState } from "@dyad/domain";
import type { AlbumRef, ArtistRef, HeardInSet, RecordingId } from "@dyad/domain";
import { Context, Effect, Layer, Option, Schema, Stream } from "effect";
import { AsyncResult, Atom, Reactivity } from "effect/reactivity";

import { ConnectionStatus, ServerConnection } from "./connection.ts";
import {
  ClientDatabase,
  accountProvidersState,
  albumPageCache,
  artistPageCache,
  homePageState,
  libraryAlbumsState,
  libraryArtistsState,
} from "./replica/database.ts";
import { catalogTables } from "./replica/rows.ts";
import { localSourceCopies } from "./replica/copies.ts";
import { localHeardInSets, localSets } from "./replica/sets.ts";
import { localProviderChoices } from "./replica/source-preference.ts";
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

const offline = new PageState({
  status: "failed",
  fetchedAt: null,
  reason: "Cannot reach the server · showing the saved page",
});

// The saved answer first, then the live answers, which the device saves. When the server cannot
// answer, the saved answer comes again, through `stale`.
const savedFirst = <A, E, R>(
  cache: {
    readonly get: Effect.Effect<Option.Option<A>, never, ClientDatabase>;
    readonly set: (value: A) => Effect.Effect<void, never, ClientDatabase>;
  },
  live: Stream.Stream<A, E, R>,
  stale: (value: A) => A,
) =>
  Stream.unwrap(
    Effect.map(cache.get, (saved) =>
      Stream.concat(
        Stream.fromIterable(Option.toArray(saved)),
        live.pipe(
          Stream.tap(cache.set),
          // A page that is gone must not show from the cache
          Stream.catchIf(
            (error) => !Schema.is(PageNotFound)(error),
            (error) =>
              Stream.unwrap(
                Effect.map(cache.get, (last) =>
                  Option.match(last, {
                    onNone: () => Stream.fail(error),
                    onSome: (value) => Stream.succeed(stale(value)),
                  }),
                ),
              ),
          ),
        ),
      ),
    ),
  );

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
    library: local(
      ["library_item", "source_preference", ...catalogTables, "client_state"],
      localLibrary,
    ),
    playlists: local(["playlist", "playlist_entry"], localPlaylists),
    playlistEntries: Atom.family((playlistId: string) =>
      local(
        ["playlist", "playlist_entry", "source_preference", ...catalogTables, "client_state"],
        localPlaylistEntries(playlistId),
      ).pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
    /** The providers in the user's order, best first, for the setting */
    providerChoices: local(["source_preference", "source", "client_state"], localProviderChoices),
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
    /** The answers are saved on the device, so that the lists show offline */
    libraryArtists: runtime.atom(
      savedFirst(
        libraryArtistsState,
        Stream.fromEffect(
          ServerConnection.use((client) => client.listLibraryArtists()).pipe(
            Effect.timeout("5 seconds"),
          ),
        ),
        (cards) => cards,
      ),
    ),
    libraryAlbums: runtime.atom(
      savedFirst(
        libraryAlbumsState,
        Stream.fromEffect(
          ServerConnection.use((client) => client.listLibraryAlbums()).pipe(
            Effect.timeout("5 seconds"),
          ),
        ),
        (cards) => cards,
      ),
    ),
    /** The device saves the last pages that it opened, so that they show offline */
    artistPage: Atom.family((ref: ArtistRef) =>
      runtime
        .atom(
          savedFirst(
            { get: artistPageCache.get(ref), set: (page) => artistPageCache.set(ref, page) },
            Stream.unwrap(ServerConnection.useSync((client) => client.artistPage({ ref }))),
            (page) => new ArtistPage({ ...page, state: offline }),
          ),
        )
        .pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
    albumPage: Atom.family((ref: AlbumRef) =>
      runtime
        .atom(
          savedFirst(
            { get: albumPageCache.get(ref), set: (page) => albumPageCache.set(ref, page) },
            Stream.unwrap(ServerConnection.useSync((client) => client.albumPage({ ref }))),
            (page) => new AlbumPage({ ...page, state: offline }),
          ),
        )
        .pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
    /** The DJ sets that the user played or saved, with their tracklists */
    sets: local(["play_event", "library_item", ...catalogTables, "client_state"], localSets),
    /** The sets that play a recording, from the server, else from the replica */
    heardInSets: Atom.family((recordingId: RecordingId) => {
      const remote = runtime.atom(
        ServerConnection.use((client) => client.heardInSets({ recordingId })).pipe(
          Effect.timeout("5 seconds"),
        ),
      );
      const replica = local([...catalogTables, "client_state"], localHeardInSets(recordingId));
      // Only a failed call falls back to the replica, so that the list does not jump
      // RETURN TYPE: the two results have different error types
      return Atom.make((get): AsyncResult.AsyncResult<ReadonlyArray<HeardInSet>, unknown> => {
        const online = get(remote);
        return AsyncResult.isFailure(online) ? get(replica) : online;
      }).pipe(Atom.setIdleTTL(pageIdleTime));
    }),
    /** The last answer about the providers and the user's linked accounts */
    accountProviders: local(["client_state"], accountProvidersState.get),
    /** The page that the device saved last first, so that the home shows offline */
    homePage: runtime.atom(
      Stream.unwrap(
        Effect.gen(function* () {
          const saved = yield* homePageState.get;
          const live = Stream.unwrap(ServerConnection.useSync((client) => client.homePage())).pipe(
            Stream.tap(homePageState.set),
          );
          return Stream.concat(Stream.fromIterable(Option.toArray(saved)), live);
        }),
      ),
    ),
    /** All copies of the recording of a source from the server, else from the replica */
    sourceCopies: Atom.family((sourceId: string) => {
      const remote = runtime.atom(
        ServerConnection.use((client) => client.sourceCopies({ sourceId })).pipe(
          Effect.timeout("5 seconds"),
        ),
      );
      const replica = local(
        ["source_preference", ...catalogTables, "client_state"],
        localSourceCopies(sourceId),
      );
      // No idle time: a changed provider order must apply at the next open
      return Atom.make((get) => {
        const online = get(remote);
        return AsyncResult.isSuccess(online) ? online : get(replica);
      });
    }),
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
