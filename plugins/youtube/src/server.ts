import { Plugin, Provider, ProviderError, Recommender } from "@dyad/plugin";
import { Clock, Data, Effect, Ref } from "effect";
import { HttpClient } from "effect/http";

import {
  playerCache,
  provider,
  resolveAudio,
  resolveVideo,
  videoTracklists,
  visitorCache,
} from "./api.ts";
import { browserLogin, readAccountName } from "./login.ts";
import { youtubeRadio, youtubeShelves } from "./recommend.ts";
import { searchMusic } from "./search.ts";
import { ytdlpResolver } from "./ytdlp.ts";

class BotCheck extends Data.TaggedError("BotCheck") {}

/**
 * Searches YouTube videos and plays their Opus audio and VP9 video, for example DJ sets and full
 * albums. The plugin uses YouTube's internal API like the YouTube apps, without an account. When
 * YouTube asks this server to sign in, yt-dlp plays with the user's optional account.
 */
export const youtubePlugin = new Plugin({
  id: "dyad.youtube",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      const players = yield* playerCache(yield* visitorCache);
      const ytdlp = yield* ytdlpResolver;
      // After the bot check or refused URLs, anonymous `/player` requests rest for an hour
      const anonymousPausedUntil = yield* Ref.make(0);

      const anonymously = <A>(resolve: Effect.Effect<A, ProviderError, HttpClient.HttpClient>) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          if (now < (yield* Ref.get(anonymousPausedUntil))) return yield* new BotCheck();
          return yield* resolve.pipe(
            Effect.provide(services),
            Effect.catchIf(
              (error) =>
                error.reason.includes("not a bot") ||
                error.reason === "YouTube answered status 403",
              () =>
                Ref.set(anonymousPausedUntil, now + 60 * 60 * 1000).pipe(
                  Effect.andThen(
                    Effect.logWarning(
                      "YouTube refuses anonymous plays from this server. No anonymous plays for 1 hour.",
                    ),
                  ),
                  Effect.andThen(Effect.fail(new BotCheck())),
                ),
            ),
          );
        });

      yield* context.provider.add(
        provider,
        new Provider({
          name: "YouTube",
          resolve: (externalId, credentials) =>
            anonymously(resolveAudio(players, externalId)).pipe(
              Effect.catchTag("BotCheck", () => ytdlp.audio(externalId, credentials)),
              Effect.provide(services),
            ),
          video: (externalId, credentials, maxHeight) =>
            anonymously(resolveVideo(players, externalId, maxHeight)).pipe(
              Effect.catchTag("BotCheck", () => ytdlp.video(externalId, credentials, maxHeight)),
              Effect.provide(services),
            ),
          search: (query) => searchMusic(query).pipe(Effect.provide(services)),
          tracklists: (externalId) => videoTracklists(externalId).pipe(Effect.provide(services)),
          uploads: true,
          download: { leaseDays: 30 },
          account: {
            login: browserLogin,
            link: (credentials) =>
              readAccountName(credentials).pipe(
                Effect.tap(() => ytdlp.resume),
                Effect.provide(services),
              ),
            optional: true,
          },
        }),
      );

      yield* context.recommenders.add(
        provider,
        new Recommender({
          name: "YouTube Music",
          priority: 20,
          radio: (seed) => youtubeRadio(seed).pipe(Effect.provide(services)),
          // The account requests of yt-dlp and of the home rest together
          shelves: (credentials) =>
            Effect.gen(function* () {
              if (yield* ytdlp.resting) {
                return yield* new ProviderError({ reason: "The YouTube account rests for 1 hour" });
              }
              return yield* youtubeShelves(credentials).pipe(
                Effect.tapError((error) =>
                  /status (401|403|429)/.test(error.reason)
                    ? ytdlp.pause(error.reason)
                    : Effect.void,
                ),
              );
            }).pipe(Effect.provide(services)),
        }),
      );
    }),
});
