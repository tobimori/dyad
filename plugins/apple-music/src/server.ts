import { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import { Plugin, Provider, ProviderAudio, ProviderError } from "@dyad/plugin";
import type { Credentials } from "@dyad/plugin";
import { Cache, Data, Effect, Exit, Option, Stream } from "effect";
import type { Redacted } from "effect";
import { HttpClient } from "effect/http";

import { AppleMusicError, sessionCache, provider, resolveAacAsset, searchCatalog } from "./api.ts";
import type { AppleSession } from "./api.ts";
import { readSegments, segmentBytes } from "./hls.ts";
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
      return yield* new AppleMusicError({ stage: "account", reason: `No ${tokenCookie} cookie` });
    }
    return token;
  });

// The asset depends on the user, because Apple checks the subscription and the storefront
class SongPlay extends Data.Class<{
  readonly mediaUserToken: Redacted.Redacted<string>;
  readonly songId: string;
}> {}

const toProviderError = (error: AppleMusicError) =>
  new ProviderError({ reason: `${error.stage}: ${error.reason}` });

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
              [readSegments(playlistUrl), contentKeys(session, play.songId, playlistUrl)],
              { concurrency: "unbounded" },
            );
            return { segments, decryptionKeys };
          }),
        );

      // Apple's web player reads the segments while the song plays, so the signed asset URLs stay
      // valid for at least the length of a song. A short time limit keeps a cached asset well
      // inside that.
      const playbacks = yield* Cache.makeWith(loadPlayback, {
        capacity: 100,
        timeToLive: (exit) => (Exit.isSuccess(exit) ? "5 minutes" : 0),
      });

      const resolve = (songId: string, credentials: Credentials) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);
          const play = new SongPlay({ mediaUserToken: token, songId });
          const { segments, decryptionKeys } = yield* Cache.get(playbacks, play);

          const bytes = segmentBytes(segments).pipe(
            Stream.mapError(toProviderError),
            Stream.provideContext(services),
          );
          return new ProviderAudio({ bytes, decryptionKeys });
        }).pipe(Effect.mapError(toProviderError), Effect.provide(services));

      // The catalog needs only the web client token, but the storefront comes from the account
      const search = (query: string, credentials: Credentials) =>
        Effect.gen(function* () {
          const token = yield* mediaUserToken(credentials);

          return yield* withSession(token, (session) =>
            searchCatalog(session.bearer, session.storefront, query),
          );
        }).pipe(Effect.mapError(toProviderError), Effect.provide(services));

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
        new Provider({ name: "Apple Music", resolve, search, account: { login, link } }),
      );
    }),
});
