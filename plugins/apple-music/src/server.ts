import { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import {
  LibraryError,
  Plugin,
  Provider,
  ProviderAudio,
  ProviderError,
  ProviderLibrary,
  ProviderPlaylists,
  Recommender,
} from "@dyad/plugin";
import type { Credentials } from "@dyad/plugin";
import { readSegments, segmentBytes, segmentsFrom } from "@dyad/plugin/hls";
import { makePacer } from "@dyad/plugin/http";
import type { HttpStatusError } from "@dyad/plugin/http";
import { Cache, Data, Effect, Exit, Option, Stream } from "effect";
import type { Redacted } from "effect";
import { HttpClient } from "effect/http";

import {
  AppleAccountError,
  AppleMusicError,
  AppleThrottled,
  sessionCache,
  provider,
  resolveAacAsset,
  searchCatalog,
} from "./api.ts";
import type { AppleSession } from "./api.ts";
import {
  addPlaylistSongs,
  createPlaylist,
  probeLibrary,
  readLibrarySongs,
  readPlaylists,
  readPlaylistTracks,
} from "./library.ts";
import { readCharts, readPersonal } from "./home.ts";
import { readAlbum, readArtist } from "./pages.ts";
import { acquireAppleKeys } from "./widevine.ts";

// The web player sets this cookie after the subscriber signs in
const tokenCookie = "media-user-token";

const login = new BrowserLogin({
  url: "https://music.apple.com/login",
  domain: "apple.com",
  cookies: [tokenCookie],
});

const mediaUserToken = (credentials: Credentials) =>
  Effect.gen(function* () {
    const token = credentials.get(tokenCookie);
    if (token === undefined) {
      return yield* new AppleAccountError({ stage: "account", reason: `No ${tokenCookie} cookie` });
    }
    return token;
  });

// The asset depends on the user, because Apple checks the subscription and the storefront
class SongPlay extends Data.Class<{
  readonly mediaUserToken: Redacted.Redacted<string>;
  readonly songId: string;
}> {}

type AppleError = AppleMusicError | AppleAccountError | AppleThrottled;

const toProviderError = (error: AppleError) =>
  new ProviderError({ reason: `${error.stage}: ${error.reason}` });

const toLibraryError = (error: AppleError) => {
  const reason = `${error.stage}: ${error.reason}`;

  if (error instanceof AppleAccountError) {
    return new LibraryError({ kind: "account", reason, retryAfterSeconds: null });
  }
  if (error instanceof AppleThrottled) {
    return new LibraryError({
      kind: "throttled",
      reason,
      retryAfterSeconds: error.retryAfterSeconds,
    });
  }
  return new LibraryError({ kind: "failed", reason, retryAfterSeconds: null });
};

/**
 * Searches the Apple Music catalog and plays its songs through the web playback route of each
 * user's linked account
 */
export const appleMusicPlugin = new Plugin({
  id: "dyad.apple-music",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      const withSession = yield* sessionCache;

      // CENC content keys belong to the song, not to the user. Only `Cache.set` adds keys, because
      // the license exchange needs the session and the asset of the user who plays.
      const songKeys = yield* Cache.make<
        string,
        Redacted.Redacted<ReadonlyMap<string, string>>,
        AppleMusicError
      >({
        capacity: 1000,
        timeToLive: "1 day",
        lookup: () =>
          Effect.fail(new AppleMusicError({ stage: "license", reason: "Keys are not cached" })),
      });

      const contentKeys = (session: AppleSession, songId: string, playlistUrl: string) =>
        Effect.gen(function* () {
          const cached = yield* Cache.getOption(songKeys, songId);
          if (Option.isSome(cached)) return cached.value;

          const keys = yield* acquireAppleKeys(session, songId, playlistUrl);
          yield* Cache.set(songKeys, songId, keys);
          return keys;
        });

      const loadPlayback = (play: SongPlay) =>
        withSession(play.mediaUserToken, (session) =>
          Effect.gen(function* () {
            const playlistUrl = yield* resolveAacAsset(session, play.songId);

            // Neither needs the result of the other
            const [segments, decryptionKeys] = yield* Effect.all(
              [
                readSegments(playlistUrl).pipe(
                  Effect.mapError(
                    () =>
                      new AppleMusicError({
                        stage: "playlist",
                        reason: "Cannot read the asset playlist",
                      }),
                  ),
                  Effect.filterOrFail(
                    (segments) => segments.length > 0,
                    () => new AppleMusicError({ stage: "playlist", reason: "No media segments" }),
                  ),
                ),
                contentKeys(session, play.songId, playlistUrl),
              ],
              { concurrency: "unbounded" },
            );
            return { segments, decryptionKeys };
          }),
        );

      // Apple's web player reads segments while the song plays, so signed asset URLs stay valid
      // for at least one song. A short time limit keeps a cached asset well inside that.
      const playbacks = yield* Cache.makeWith(loadPlayback, {
        capacity: 100,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      });

      const resolve = (songId: string, credentials: Credentials) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);
          const play = new SongPlay({ mediaUserToken: token, songId });
          const { segments, decryptionKeys } = yield* Cache.get(playbacks, play);

          const read = (selected: typeof segments) =>
            segmentBytes(selected).pipe(
              // Errors contain the signed segment URL
              Stream.mapError(() =>
                toProviderError(
                  new AppleMusicError({
                    stage: "segments",
                    reason: "Cannot read an audio segment",
                  }),
                ),
              ),
              Stream.provideContext(services),
            );
          return new ProviderAudio({
            bytes: read(segments),
            bytesFrom: (startMs) => read(segmentsFrom(segments, startMs)),
            decryptionKeys,
          });
        }).pipe(Effect.mapError(toProviderError), Effect.provide(services));

      // Keys that are not in memory, for example after a restart, need the asset again for the
      // license exchange
      const keys = (songId: string, credentials: Credentials) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);
          const cached = yield* Cache.getOption(songKeys, songId);
          if (Option.isSome(cached)) return cached.value;

          return yield* withSession(token, (session) =>
            Effect.gen(function* () {
              const playlistUrl = yield* resolveAacAsset(session, songId);
              return yield* contentKeys(session, songId, playlistUrl);
            }),
          );
        }).pipe(Effect.mapError(toProviderError), Effect.provide(services));

      // The catalog needs only the web client token, but the storefront comes from the account
      const search = (query: string, credentials: Credentials) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);

          return yield* withSession(token, (session) =>
            searchCatalog(session.bearer, session.storefront, query),
          );
        }).pipe(Effect.mapError(toProviderError), Effect.provide(services));

      // Pages come from the catalog of the user's storefront, like search results
      const catalogPage = <A>(
        credentials: Credentials,
        read: (
          session: AppleSession,
        ) => Effect.Effect<A, AppleError | HttpStatusError, HttpClient.HttpClient>,
      ) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);
          return yield* withSession(token, read);
        }).pipe(Effect.mapError(toProviderError), Effect.provide(services));

      // Apple throttles fast library reads. Search and playback do not wait for this queue.
      const libraryPace = yield* makePacer(1000);

      const readLibrary =
        <A>(
          read: (
            session: AppleSession,
          ) => Effect.Effect<A, AppleError | HttpStatusError, HttpClient.HttpClient>,
        ) =>
        (credentials: Credentials) =>
          Effect.gen(function* () {
            const token = yield* mediaUserToken(credentials);
            return yield* withSession(token, read);
          }).pipe(Effect.mapError(toLibraryError), Effect.provide(services));

      const library = new ProviderLibrary({
        probe: readLibrary((session) => probeLibrary(libraryPace, session)),
        songs: readLibrary((session) => readLibrarySongs(libraryPace, session)),
        playlists: readLibrary((session) => readPlaylists(libraryPace, session)),
        playlistSongs: (credentials, remoteId) =>
          readLibrary((session) => readPlaylistTracks(libraryPace, session, remoteId))(credentials),
      });

      const playlists = new ProviderPlaylists({
        create: (credentials, name) =>
          readLibrary((session) => createPlaylist(libraryPace, session, name))(credentials),
        add: (credentials, remoteId, songs) =>
          readLibrary((session) => addPlaylistSongs(libraryPace, session, remoteId, songs))(
            credentials,
          ),
      });

      const link = (credentials: Credentials) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);
          const session = yield* withSession(token, Effect.succeed);
          return `Apple Music (${session.storefront.toUpperCase()})`;
        }).pipe(
          Effect.mapError((error) => new AccountLinkFailed({ reason: error.reason })),
          Effect.provide(services),
        );

      yield* context.provider.add(
        provider,
        new Provider({
          name: "Apple Music",
          resolve,
          keys,
          search,
          artist: (id, credentials) =>
            catalogPage(credentials, (session) => readArtist(session, id)),
          album: (id, credentials) => catalogPage(credentials, (session) => readAlbum(session, id)),
          home: (credentials) => catalogPage(credentials, readCharts),
          account: { login, link },
          library,
          playlists,
          metadataPriority: 30,
          download: { leaseDays: 30 },
          // Library IDs such as `i.abc` have no public page. The site picks the storefront.
          webUrl: (id) => (/^\d+$/.test(id) ? `https://music.apple.com/song/${id}` : null),
        }),
      );

      yield* context.recommenders.add(
        provider,
        new Recommender({
          name: "Apple Music",
          shelves: (credentials) => catalogPage(credentials, readPersonal),
        }),
      );
    }),
});
