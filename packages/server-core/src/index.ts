import { dieOnDatabaseError, orDieOnDatabaseError } from "@dyad/db/node";
import { CurrentPrincipal, ServerDescriptor, ServerRpc, SourceCopies } from "@dyad/domain";
import { Context, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { linkAccount, listAccountProviders, listAccounts, unlinkAccount } from "./accounts.ts";
import {
  authenticationLayer,
  createPairingCode,
  listDevices,
  pair,
  pairingCodesLayer,
  removeDevice,
} from "./auth.ts";
import { audioAnalysisLayer } from "./audio-analysis.ts";
import { checkInDownloads, downloadRoute, prepareDownload } from "./downloads.ts";
import { insertPlay, listRecentPlays } from "./history.ts";
import { homePage } from "./home.ts";
import { forwardEffect, forwardStream } from "./home-server.ts";
import { jobsLayer } from "./jobs.ts";
import { getLibrarySyncStatus, syncLibrary } from "./library-sync.ts";
import { decideMerge, musicbrainzLookupsLayer } from "./matching.ts";
import {
  albumPage,
  artistPage,
  artistSearchesLayer,
  listLibraryAlbums,
  listLibraryArtists,
} from "./pages.ts";
import { mediaCacheLayer } from "./media-cache.ts";
import { liveRoute } from "./live-output.ts";
import { outputsLayer } from "./outputs.ts";
import { copyAttemptsLayer, preparePlayback, streamKeyLayer, streamRoute } from "./playback.ts";
import { receiversLayer } from "./receivers.ts";
import { providerCacheSweepLayer } from "./provider-cache.ts";
import { popularitiesLayer, providersLayer } from "./providers.ts";
import { recommendersLayer } from "./recommenders.ts";
import { radio } from "./radio.ts";
import { search, searchCatalog } from "./search.ts";
import { connectDevice, controlSession, reportPlayback, sessionsLayer } from "./sessions.ts";
import {
  addPlaylistEntries,
  createPlaylist,
  editPlaylist,
  listPlaylists,
  movePlaylistEntry,
  removePlaylistEntry,
} from "./playlists.ts";
import { heardInSets, listSets } from "./sets.ts";
import { listProviderChoices, setProviderOrder } from "./source-preference.ts";
import {
  copyDiscoveriesLayer,
  copySearchesLayer,
  sourceCopies,
  sourceCopiesStream,
} from "./source-copies.ts";
import { listSources } from "./sources.ts";
import { listServerPeers, pairServer, peerEchoesLayer, peerRoutes, unpairServer } from "./peers.ts";
import { syncHubLayer, watchChanges } from "./sync.ts";
import { timedRoute } from "./timed-route.ts";
import { hideTracklist, sourceSegments, tracklistsServiceLayer } from "./tracklists.ts";
import { listMarks, listLibrary, listPlaylistEntries, setLibraryMark } from "./user-library.ts";
import { prepareVideo, videoRoute } from "./video.ts";
import { webLinks } from "./web-links.ts";

export { catalogLayer } from "./catalog-backfill.ts";
export { hlcClockFromDatabase } from "./clock.ts";
export { librarySyncLayer } from "./library-sync.ts";
export { MediaCacheConfig } from "./media-cache.ts";
export { StreamPort } from "./outputs.ts";
export { createDevice } from "./auth.ts";
export { HomeServer } from "./home-server.ts";
export { JoinFailed, joinWorkspace, peerSyncLayer } from "./peers.ts";
export { pluginLayer } from "./plugin.ts";
export { recommendationsLayer } from "./recommenders.ts";
export { tracklistsLayer } from "./tracklists.ts";

export class ServerIdentity extends Context.Service<ServerIdentity, ServerDescriptor>()(
  "@dyad/server-core/ServerIdentity",
) {}

/** Replica services that plugins and routes share */
export const coreServicesLayer = Layer.mergeAll(sessionsLayer, audioAnalysisLayer).pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      providersLayer,
      popularitiesLayer,
      recommendersLayer,
      streamKeyLayer,
      pairingCodesLayer,
      providerCacheSweepLayer,
      mediaCacheLayer,
      musicbrainzLookupsLayer,
      copyAttemptsLayer,
      copySearchesLayer,
      copyDiscoveriesLayer,
      artistSearchesLayer,
      outputsLayer,
      receiversLayer,
      syncHubLayer,
      peerEchoesLayer,
      tracklistsServiceLayer,
    ),
  ),
  Layer.provideMerge(jobsLayer),
);

export const serverRoutes = Layer.unwrap(
  Effect.gen(function* () {
    const descriptor = yield* ServerIdentity;
    const handlers = ServerRpc.toLayer({
      describe: () => Effect.succeed(descriptor),
      pair: ({ code, deviceName }) => pair(code, deviceName).pipe(orDieOnDatabaseError("pair")),
      listSources: () => listSources.pipe(orDieOnDatabaseError("listSources")),
      listPlaylistEntries: ({ playlistId }) =>
        listPlaylistEntries(playlistId).pipe(orDieOnDatabaseError("listPlaylistEntries")),
      // The replica with the credentials imports the libraries
      getLibrarySyncStatus: () =>
        forwardEffect(
          (home) => home.getLibrarySyncStatus(),
          getLibrarySyncStatus.pipe(orDieOnDatabaseError("getLibrarySyncStatus")),
        ),
      syncLibrary: ({ provider }) =>
        forwardEffect(
          (home) => home.syncLibrary({ provider }),
          syncLibrary(provider).pipe(orDieOnDatabaseError("syncLibrary")),
        ),
      search: ({ query }) =>
        forwardStream(
          (home) => home.search({ query }),
          // Only database errors remain
          search(query).pipe(Stream.catch(() => Stream.fromEffect(dieOnDatabaseError("search")))),
          // A device never asks providers itself, so offline it searches only its catalog
          searchCatalog(query).pipe(
            Stream.catch(() => Stream.fromEffect(dieOnDatabaseError("search"))),
          ),
        ),
      artistPage: ({ ref }) => forwardStream((home) => home.artistPage({ ref }), artistPage(ref)),
      albumPage: ({ ref }) => forwardStream((home) => home.albumPage({ ref }), albumPage(ref)),
      homePage: () => forwardStream((home) => home.homePage(), homePage),
      radio: ({ start }) =>
        forwardEffect(
          (home) => home.radio({ start }),
          radio(start).pipe(orDieOnDatabaseError("radio")),
        ),
      listLibraryArtists: () => listLibraryArtists.pipe(orDieOnDatabaseError("listLibraryArtists")),
      listLibraryAlbums: () => listLibraryAlbums.pipe(orDieOnDatabaseError("listLibraryAlbums")),
      preparePlayback: ({ sourceId, capabilities }) =>
        preparePlayback(sourceId, capabilities).pipe(orDieOnDatabaseError("preparePlayback")),
      prepareVideo: ({ sourceId, maxHeight }) =>
        prepareVideo(sourceId, maxHeight).pipe(orDieOnDatabaseError("prepareVideo")),
      connectDevice: (payload) =>
        Stream.unwrap(connectDevice(payload).pipe(orDieOnDatabaseError("connectDevice"))),
      controlSession: (payload) =>
        controlSession(payload).pipe(orDieOnDatabaseError("controlSession")),
      reportPlayback: (payload) => reportPlayback(payload),
      listLibrary: () => listLibrary.pipe(orDieOnDatabaseError("listLibrary")),
      listPlaylists: () => listPlaylists.pipe(orDieOnDatabaseError("listPlaylists")),
      listRecentPlays: () => listRecentPlays.pipe(orDieOnDatabaseError("listRecentPlays")),
      listSets: () => listSets.pipe(orDieOnDatabaseError("listSets")),
      listProviderChoices: () =>
        listProviderChoices.pipe(orDieOnDatabaseError("listProviderChoices")),
      setProviderOrder: ({ providerRanking }) =>
        setProviderOrder(providerRanking).pipe(orDieOnDatabaseError("setProviderOrder")),
      createPlaylist: ({ name, entries, twoWayProvider }) =>
        createPlaylist(name, entries, twoWayProvider).pipe(orDieOnDatabaseError("createPlaylist")),
      addPlaylistEntries: ({ playlistId, entries }) =>
        addPlaylistEntries(playlistId, entries).pipe(orDieOnDatabaseError("addPlaylistEntries")),
      editPlaylist: ({ playlistId, ...edit }) =>
        editPlaylist(playlistId, edit).pipe(orDieOnDatabaseError("editPlaylist")),
      removePlaylistEntry: ({ entryId }) =>
        removePlaylistEntry(entryId).pipe(orDieOnDatabaseError("removePlaylistEntry")),
      listMarks: () => listMarks.pipe(orDieOnDatabaseError("listMarks")),
      setLibraryMark: ({ entityType, entityId, mark, sourceId }) =>
        setLibraryMark(entityType, entityId, mark, sourceId).pipe(
          orDieOnDatabaseError("setLibraryMark"),
        ),
      movePlaylistEntry: ({ playlistId, entryId, direction }) =>
        movePlaylistEntry(playlistId, entryId, direction).pipe(
          orDieOnDatabaseError("movePlaylistEntry"),
        ),
      appendPlay: (play) =>
        Effect.flatMap(CurrentPrincipal, (principal) =>
          insertPlay({ ...play, deviceId: principal.deviceId }),
        ).pipe(orDieOnDatabaseError("appendPlay")),
      watchChanges: () => watchChanges,
      prepareDownload: ({ sourceId, quality, capabilities }) =>
        prepareDownload(sourceId, quality, capabilities).pipe(
          orDieOnDatabaseError("prepareDownload"),
        ),
      checkInDownloads: ({ sourceIds }) =>
        checkInDownloads(sourceIds).pipe(orDieOnDatabaseError("checkInDownloads")),
      createPairingCode: () => createPairingCode,
      listDevices: () => listDevices.pipe(orDieOnDatabaseError("listDevices")),
      removeDevice: ({ deviceId }) =>
        removeDevice(deviceId).pipe(orDieOnDatabaseError("removeDevice")),
      listAccountProviders: () => listAccountProviders,
      listAccounts: () => listAccounts.pipe(orDieOnDatabaseError("listAccounts")),
      // The credentials stay on the home server, which then runs the jobs of the account
      linkAccount: ({ provider, credentials }) =>
        forwardEffect(
          (home) => home.linkAccount({ provider, credentials }),
          linkAccount(provider, credentials).pipe(orDieOnDatabaseError("linkAccount")),
        ),
      unlinkAccount: ({ provider }) =>
        forwardEffect(
          (home) => home.unlinkAccount({ provider }),
          unlinkAccount(provider).pipe(orDieOnDatabaseError("unlinkAccount")),
        ),
      unmergeRecording: (pair) =>
        decideMerge(pair, "reject").pipe(orDieOnDatabaseError("unmergeRecording")),
      mergeRecordings: (pair) =>
        decideMerge(pair, "merge").pipe(orDieOnDatabaseError("mergeRecordings")),
      sourceSegments: ({ sourceId }) =>
        sourceSegments(sourceId).pipe(
          Stream.catch(() => Stream.fromEffect(dieOnDatabaseError("sourceSegments"))),
        ),
      hideTracklist: ({ sourceId, hidden }) =>
        hideTracklist(sourceId, hidden).pipe(orDieOnDatabaseError("hideTracklist")),
      heardInSets: ({ recordingId }) =>
        heardInSets(recordingId).pipe(orDieOnDatabaseError("heardInSets")),
      webLinks: ({ sourceId }) => webLinks(sourceId).pipe(orDieOnDatabaseError("webLinks")),
      sourceCopies: ({ sourceId }) =>
        forwardStream(
          (home) => home.sourceCopies({ sourceId }),
          sourceCopiesStream(sourceId).pipe(
            Stream.catch(() => Stream.fromEffect(dieOnDatabaseError("sourceCopies"))),
          ),
          // Offline, a device shows the copies that it knows
          Stream.fromEffect(
            sourceCopies(sourceId).pipe(
              Effect.map((copies) => new SourceCopies({ copies, searching: false })),
              orDieOnDatabaseError("sourceCopies"),
            ),
          ),
        ),
      pairServer: (payload) => pairServer(payload).pipe(orDieOnDatabaseError("pairServer")),
      listServerPeers: () => listServerPeers.pipe(orDieOnDatabaseError("listServerPeers")),
      unpairServer: ({ replicaId }) =>
        unpairServer(replicaId).pipe(orDieOnDatabaseError("unpairServer")),
    });

    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/dyad/server",
        HttpServerResponse.schemaJson(ServerDescriptor)(descriptor),
      ),
      HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
      streamRoute,
      timedRoute,
      liveRoute,
      videoRoute,
      downloadRoute,
      peerRoutes,
      RpcServer.layerHttp({ group: ServerRpc, path: "/rpc" }).pipe(
        Layer.provide(handlers),
        Layer.provide(authenticationLayer),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
  }),
);
