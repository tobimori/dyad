import type { AlbumRef, ArtistRef, RecordingId } from "@dyad/domain";
import { Context, Data, Effect, Layer, Option, Schedule, Stream } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { ConnectionStatus, ServerConnection } from "./connection.ts";

// Idle pages keep their last emission this long, so back navigation is instant
const pageIdleTime = "5 minutes";

/** The providers with accounts, and which of them the user linked */
export class AccountProviders extends Data.Class<{
  /** Display names of the providers that need an account */
  readonly names: Readonly<Record<string, string>>;
  readonly linked: ReadonlyArray<string>;
  /** The providers that can create a playlist for a two-way link */
  readonly createPlaylists: ReadonlyArray<string>;
}> {}

// The replica imports provider libraries in the background, so the client polls the cheap status
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
 * The atoms use the connection of `services` to the replica of this device. The views load again
 * after each change of the replica. `logging` sends their logs to the client's logger.
 */
export const serverAtoms = (
  services: Context.Context<ServerConnection | ConnectionStatus>,
  logging: Layer.Layer<never>,
) => {
  const runtime = Atom.runtime(Layer.succeedContext(services).pipe(Layer.provideMerge(logging)));

  // The replica is on this device, so a lost connection comes back soon
  const live = <A, E>(query: (client: typeof ServerConnection.Service) => Effect.Effect<A, E>) =>
    runtime.atom(
      Stream.unwrap(
        ServerConnection.useSync((client) =>
          client.watchChanges().pipe(
            Stream.switchMap(() => Stream.fromEffect(query(client))),
            Stream.retry(Schedule.spaced("1 second")),
          ),
        ),
      ),
    );

  const accountProviders = live((client) =>
    Effect.all([client.listAccountProviders(), client.listAccounts()]).pipe(
      Effect.map(
        ([providers, accounts]) =>
          new AccountProviders({
            names: Object.fromEntries(
              providers.map((provider) => [provider.provider, provider.name]),
            ),
            linked: accounts.map((account) => account.provider),
            createPlaylists: providers.flatMap((provider) =>
              provider.createsPlaylists ? [provider.provider] : [],
            ),
          }),
      ),
    ),
  );

  return {
    connection: runtime.atom(ServerConnection),
    // `Atom` 4.0.5 calls an argument that is a function, and a service key is a class
    status: runtime.subscriptionRef(() => Effect.service(ConnectionStatus)),
    sources: live((client) => client.listSources()),
    library: live((client) => client.listLibrary()),
    disliked: live((client) => client.listDisliked()),
    playlists: live((client) => client.listPlaylists()),
    playlistEntries: Atom.family((playlistId: string) =>
      live((client) => client.listPlaylistEntries({ playlistId })).pipe(
        Atom.setIdleTTL(pageIdleTime),
      ),
    ),
    /** The providers in the user's order, best first, for the setting */
    providerChoices: live((client) => client.listProviderChoices()),
    librarySyncStatus: runtime.atom(Stream.unwrap(ServerConnection.useSync(pollSyncStatus))),
    accountProviders,
    providerNames: Atom.map(accountProviders, (result) =>
      AsyncResult.map(result, (providers) => new Map(Object.entries(providers.names))),
    ),
    /** The linked providers that can create a playlist for a two-way link, with their names */
    playlistProviders: Atom.map(accountProviders, (result) =>
      AsyncResult.map(result, (providers) =>
        providers.createPlaylists.flatMap((provider) =>
          providers.linked.includes(provider)
            ? [{ provider, name: providers.names[provider] ?? provider }]
            : [],
        ),
      ),
    ),
    recentPlays: live((client) => client.listRecentPlays()),
    libraryArtists: live((client) => client.listLibraryArtists()),
    libraryAlbums: live((client) => client.listLibraryAlbums()),
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
    /** The DJ sets that the user played or saved, with their tracklists */
    sets: live((client) => client.listSets()),
    heardInSets: Atom.family((recordingId: RecordingId) =>
      live((client) => client.heardInSets({ recordingId })).pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
    /**
     * All copies of the recording of a source, again after each change and after the server
     * searched the providers. No idle time: a new order applies at once.
     */
    sourceCopies: Atom.family((sourceId: string) =>
      runtime.atom(
        Stream.unwrap(
          ServerConnection.useSync((client) =>
            client.watchChanges().pipe(
              Stream.switchMap(() => client.sourceCopies({ sourceId })),
              Stream.retry(Schedule.spaced("1 second")),
            ),
          ),
        ),
      ),
    ),
    /** The tracklist of a DJ set source */
    sourceSegments: Atom.family((sourceId: string) =>
      runtime
        .atom(
          Stream.unwrap(ServerConnection.useSync((client) => client.sourceSegments({ sourceId }))),
        )
        .pipe(Atom.setIdleTTL(pageIdleTime)),
    ),
  };
};

export type ServerAtoms = ReturnType<typeof serverAtoms>;
