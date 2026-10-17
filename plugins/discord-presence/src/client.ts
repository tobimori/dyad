import { ClientPlugin } from "@dyad/plugin/client";
import type { NowPlaying } from "@dyad/plugin/client";
import { Effect, Stream, SubscriptionRef } from "effect";

import { Activity, presence } from "./ipc.ts";

// The ID of the "Dyad" Discord application is public: each client sends it in the handshake, and
// Rich Presence needs no client secret
const applicationId = "1561107467197218997";

// Art asset of the Discord application
const fallbackCover = "dyad";

const maxTextLength = 128;
// Discord keeps the original URL in its media proxy path, which has a length limit
const maxCoverUrlLength = 313;

// Libraries report that Discord rejects text with fewer than 2 characters. A blank Braille pattern
// fills it and not a space, so that trimming cannot remove the fill.
const fitText = (text: string) => {
  const characters = Array.from(text);
  if (characters.length > maxTextLength) {
    return `${characters.slice(0, maxTextLength - 1).join("")}…`;
  }
  if (characters.length < 2) return text + "\u2800".repeat(2 - characters.length);
  return text;
};

// Other Discord users can read the cover URL. A URL of the Dyad server would show its address, and
// a file URL would show a path, so only public HTTPS covers of providers go out.
const coverOf = (artworkUrl: string | null, serverOrigin: string) => {
  if (artworkUrl === null || artworkUrl.length > maxCoverUrlLength) return fallbackCover;

  const url = URL.parse(artworkUrl);
  if (url === null || url.protocol !== "https:" || url.origin === serverOrigin) {
    return fallbackCover;
  }
  return artworkUrl;
};

// A paused source has no activity, because Discord counts the elapsed time on its own
const activityOf = (nowPlaying: NowPlaying | null, serverOrigin: string) => {
  if (nowPlaying === null || nowPlaying.state === "paused") return null;

  const source = nowPlaying.source;
  const start = Math.round(nowPlaying.at - nowPlaying.positionMs);
  const end =
    nowPlaying.durationMs === null ? undefined : start + Math.round(nowPlaying.durationMs);

  // `JSON.stringify` leaves out the fields that are `undefined`
  return new Activity({
    type: 2,
    status_display_type: source.artist === null ? undefined : 1,
    details: fitText(source.title ?? "Unknown title"),
    state: source.artist === null ? undefined : fitText(source.artist),
    timestamps: { start, end },
    assets: {
      large_image: coverOf(source.artworkUrl, serverOrigin),
      large_text: source.album === null ? undefined : fitText(source.album),
    },
  });
};

/** Discord cannot set a user's presence from a server, so this needs the local desktop client */
export const discordPresencePlugin = new ClientPlugin({
  id: "dyad.discord-presence",
  name: "Discord presence",
  notice: "Discord presence on. It shows while Discord runs.",
  setup: (context) =>
    Effect.gen(function* () {
      const activity = yield* SubscriptionRef.make<Activity | null>(null);

      yield* context.playback.nowPlaying.pipe(
        Stream.runForEach((nowPlaying) =>
          SubscriptionRef.set(activity, activityOf(nowPlaying, context.serverOrigin)),
        ),
        Effect.forkScoped,
      );
      yield* Effect.forkScoped(presence(applicationId, activity));
    }),
});
