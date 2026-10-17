import { AccountLinkFailed, BrowserLogin } from "@dyad/domain";
import { AccountProvider, Plugin, ProviderAudio, ProviderSource, ResolveError } from "@dyad/plugin";
import type { Credentials } from "@dyad/plugin";
import { Config, Effect, Option, Stream } from "effect";
import type { Context } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import {
  AppleMusicError,
  getCatalogTrack,
  getWebBearer,
  openAppleSession,
  resolveAacAsset,
} from "./api.ts";
import { readSegments, segmentBytes } from "./hls.ts";
import { acquireAppleKeys } from "./widevine.ts";

const provider = "apple_music";

// The web player sets this cookie after the subscriber signs in
const tokenCookie = "media-user-token";

const login = new BrowserLogin({
  url: "https://music.apple.com/login",
  domain: "apple.com",
  cookies: [tokenCookie],
});

const mediaUserToken = (credentials: Credentials) =>
  Option.fromUndefinedOr(credentials.get(tokenCookie));

// Song links are `/<storefront>/song/<name>/<id>`. Album links give the song as `?i=<id>`.
const parseSongLink = (link: string) => {
  const url = URL.parse(link);
  if (url === null) return Option.none();

  const [storefront] = url.pathname.split("/").filter(Boolean);
  const id = url.searchParams.get("i") ?? url.pathname.split("/").at(-1) ?? "";
  if (storefront === undefined || !/^\d+$/.test(id)) return Option.none();

  return Option.some({ storefront, id });
};

const resolver =
  (services: Context.Context<HttpClient.HttpClient>) =>
  (songId: string, credentials: Credentials) =>
    Effect.gen(function* () {
      const token = mediaUserToken(credentials);
      if (Option.isNone(token)) {
        return yield* new AppleMusicError({ stage: "account", reason: "No token" });
      }

      const session = yield* openAppleSession(token.value);
      const playlistUrl = yield* resolveAacAsset(session, songId);
      const decryptionKeys = yield* acquireAppleKeys(session, songId, playlistUrl);
      const segments = yield* readSegments(playlistUrl);
      const bytes = segmentBytes(segments).pipe(
        Stream.mapError((error) => new ResolveError({ reason: error.reason })),
        Stream.provideContext(services),
      );
      return new ProviderAudio({ bytes, decryptionKeys });
    }).pipe(
      Effect.mapError((error) => new ResolveError({ reason: `${error.stage}: ${error.reason}` })),
      Effect.provide(services),
    );

/**
 * Plays Apple Music songs through the web playback route of each user's linked account.
 * `DYAD_APPLE_MUSIC_SONG` is a song link that the server adds to the catalog when it starts.
 */
export const appleMusicPlugin = new Plugin({
  id: "dyad.apple-music",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();

      const link = (credentials: Credentials) =>
        Effect.gen(function* () {
          const token = mediaUserToken(credentials);
          if (Option.isNone(token)) {
            return yield* new AccountLinkFailed({ reason: `The ${tokenCookie} cookie is missing` });
          }

          const session = yield* openAppleSession(token.value).pipe(
            Effect.mapError((error) => new AccountLinkFailed({ reason: error.reason })),
          );
          return `Apple Music (${session.storefront.toUpperCase()})`;
        }).pipe(Effect.provide(services));

      yield* context.account.add(
        provider,
        new AccountProvider({ name: "Apple Music", login, link }),
      );

      yield* context.resolver.add(provider, resolver(services));

      const songLink = yield* Config.option(Config.NonEmptyString("DYAD_APPLE_MUSIC_SONG"));
      if (Option.isNone(songLink)) return;

      const song = parseSongLink(songLink.value);
      if (Option.isNone(song)) {
        return yield* Effect.logError("DYAD_APPLE_MUSIC_SONG is not an Apple Music song link");
      }

      const addSong = Effect.gen(function* () {
        const bearer = yield* getWebBearer;
        const track = yield* getCatalogTrack(bearer, song.value.storefront, song.value.id);
        yield* context.source.add(
          new ProviderSource({
            provider,
            externalId: track.id,
            title: track.attributes.name,
            artist: track.attributes.artistName,
            album: track.attributes.albumName ?? null,
            durationMs: track.attributes.durationInMillis,
            container: "mov",
            codec: "aac",
            lossless: false,
            encrypted: true,
          }),
        );
      }).pipe(Effect.catch((error) => Effect.logError("Cannot add the Apple Music song", error)));

      // The catalog request must not delay the server start
      yield* Effect.forkScoped(addSong);
    }).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.catch((error) => Effect.logError("Apple Music setup failed", error)),
    ),
});
