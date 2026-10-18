import { dieOnDatabaseError, orDieOnDatabaseError } from "@dyad/db/node";
import { ServerDescriptor, ServerRpc } from "@dyad/domain";
import { Context, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { linkAccount, listAccountProviders, listAccounts, unlinkAccount } from "./accounts.ts";
import {
  authCodesLayer,
  authenticationLayer,
  createPairingCode,
  listDevices,
  login,
  pair,
  removeDevice,
  setup,
} from "./auth.ts";
import { audioAnalysisLayer } from "./audio-analysis.ts";
import { checkInDownloads, downloadRoute, prepareDownload } from "./downloads.ts";
import { listRecentPlays } from "./history.ts";
import { homePage } from "./home.ts";
import { jobsLayer } from "./jobs.ts";
import { getLibrarySyncStatus, syncLibrary } from "./library-sync.ts";
import { decideMerge, musicbrainzLookupsLayer } from "./matching.ts";
import { albumPage, artistPage, listLibraryAlbums, listLibraryArtists } from "./pages.ts";
import { mediaCacheLayer } from "./media-cache.ts";
import { outputsLayer } from "./outputs.ts";
import { preparePlayback, streamKeyLayer, streamRoute } from "./playback.ts";
import { providerCacheSweepLayer } from "./provider-cache.ts";
import { popularitiesLayer, providersLayer } from "./providers.ts";
import { search } from "./search.ts";
import { connectDevice, controlSession, reportPlayback, sessionsLayer } from "./sessions.ts";
import { listSources } from "./sources.ts";
import { syncHubLayer, syncPull, syncPush, syncWatch } from "./sync.ts";
import { hideTracklist, sourceSegments, tracklistsServiceLayer } from "./tracklists.ts";
import { listLibrary, listPlaylistEntries, listPlaylists } from "./user-library.ts";
import { prepareVideo, videoRoute } from "./video.ts";

export { catalogLayer } from "./catalog-backfill.ts";
export { hlcClockFromDatabase } from "./clock.ts";
export { librarySyncLayer } from "./library-sync.ts";
export { MediaCacheConfig } from "./media-cache.ts";
export { StreamPort } from "./outputs.ts";
export { pluginLayer } from "./plugin.ts";
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
      streamKeyLayer,
      authCodesLayer,
      providerCacheSweepLayer,
      mediaCacheLayer,
      musicbrainzLookupsLayer,
      outputsLayer,
      syncHubLayer,
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
      setup: (payload) => setup(payload).pipe(orDieOnDatabaseError("setup")),
      login: (payload) => login(payload).pipe(orDieOnDatabaseError("login")),
      pair: ({ code, deviceName }) => pair(code, deviceName).pipe(orDieOnDatabaseError("pair")),
      listSources: () => listSources.pipe(orDieOnDatabaseError("listSources")),
      listLibrary: () => listLibrary.pipe(orDieOnDatabaseError("listLibrary")),
      listPlaylists: () => listPlaylists.pipe(orDieOnDatabaseError("listPlaylists")),
      listPlaylistEntries: ({ playlistId }) =>
        listPlaylistEntries(playlistId).pipe(orDieOnDatabaseError("listPlaylistEntries")),
      getLibrarySyncStatus: () =>
        getLibrarySyncStatus.pipe(orDieOnDatabaseError("getLibrarySyncStatus")),
      syncLibrary: ({ provider }) =>
        syncLibrary(provider).pipe(orDieOnDatabaseError("syncLibrary")),
      listRecentPlays: () => listRecentPlays.pipe(orDieOnDatabaseError("listRecentPlays")),
      search: ({ query }) =>
        // Only database errors remain
        search(query).pipe(Stream.catch(() => Stream.fromEffect(dieOnDatabaseError("search")))),
      artistPage: ({ ref }) => artistPage(ref),
      albumPage: ({ ref }) => albumPage(ref),
      homePage: () => homePage,
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
      syncPull: (request) => syncPull(request).pipe(orDieOnDatabaseError("syncPull")),
      syncPush: (request) => syncPush(request).pipe(orDieOnDatabaseError("syncPush")),
      syncWatch: () => syncWatch,
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
      linkAccount: ({ provider, credentials }) =>
        linkAccount(provider, credentials).pipe(orDieOnDatabaseError("linkAccount")),
      unlinkAccount: ({ provider }) =>
        unlinkAccount(provider).pipe(orDieOnDatabaseError("unlinkAccount")),
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
    });

    return Layer.mergeAll(
      HttpRouter.add(
        "GET",
        "/.well-known/dyad/server",
        HttpServerResponse.schemaJson(ServerDescriptor)(descriptor),
      ),
      HttpRouter.add("GET", "/health", HttpServerResponse.text("ok")),
      streamRoute,
      videoRoute,
      downloadRoute,
      RpcServer.layerHttp({ group: ServerRpc, path: "/rpc" }).pipe(
        Layer.provide(handlers),
        Layer.provide(authenticationLayer),
        Layer.provide(RpcSerialization.layerJson),
      ),
    );
  }),
);
