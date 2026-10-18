import { CreditedArtist, ProviderError, ProviderSource } from "@dyad/plugin";
import { getJson, HttpStatusError } from "@dyad/plugin/http";
import { clockMs } from "@dyad/plugin/tracklist";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { searchVideos } from "./api.ts";

const remix = { clientName: "WEB_REMIX", clientVersion: "1.20260617.01.00", hl: "en", gl: "US" };

// The `params` of the "Songs" and "Videos" filters of YouTube Music
const songsOnly = "EgWKAQIIAWoMEA4QChADEAQQCRAF";
const videosOnly = "EgWKAQIQAWoMEA4QChADEAQQCRAF";

// Itag 251, which nearly every video has, is Opus of up to 160 kbit/s
const opusBitrate = 160_000;

const setMs = 20 * 60 * 1000;

const Run = Schema.Struct({
  text: Schema.String,
  navigationEndpoint: Schema.optional(
    Schema.Struct({
      browseEndpoint: Schema.optional(
        Schema.Struct({
          browseId: Schema.String,
          browseEndpointContextSupportedConfigs: Schema.Struct({
            browseEndpointContextMusicConfig: Schema.Struct({ pageType: Schema.String }),
          }),
        }),
      ),
    }),
  ),
});

const ListItem = Schema.Struct({
  flexColumns: Schema.Array(
    Schema.Struct({
      musicResponsiveListItemFlexColumnRenderer: Schema.Struct({
        text: Schema.Struct({ runs: Schema.optional(Schema.Array(Run)) }),
      }),
    }),
  ),
  thumbnail: Schema.Struct({
    musicThumbnailRenderer: Schema.Struct({
      thumbnail: Schema.Struct({
        thumbnails: Schema.Array(Schema.Struct({ url: Schema.String, width: Schema.Finite })),
      }),
    }),
  }),
  // Missing for items that do not play
  playlistItemData: Schema.optional(Schema.Struct({ videoId: Schema.String })),
  badges: Schema.optional(
    Schema.Array(
      Schema.Struct({
        musicInlineBadgeRenderer: Schema.optional(
          Schema.Struct({ icon: Schema.Struct({ iconType: Schema.String }) }),
        ),
      }),
    ),
  ),
});

const MusicSearch = Schema.Struct({
  contents: Schema.Struct({
    tabbedSearchResultsRenderer: Schema.Struct({
      tabs: Schema.Array(
        Schema.Struct({
          tabRenderer: Schema.Struct({
            content: Schema.Struct({
              sectionListRenderer: Schema.Struct({
                contents: Schema.Array(
                  Schema.Struct({
                    // Missing when nothing matches
                    musicShelfRenderer: Schema.optional(
                      Schema.Struct({
                        contents: Schema.Array(
                          Schema.Struct({
                            musicResponsiveListItemRenderer: Schema.optional(ListItem),
                          }),
                        ),
                      }),
                    ),
                  }),
                ),
              }),
            }),
          }),
        }),
      ),
    }),
  }),
});

const pageType = (run: typeof Run.Type) =>
  run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs
    .browseEndpointContextMusicConfig.pageType;

// The second column is `Artist • Album • 3:45` for a song and `Channel • 1.2M views • 3:45` for
// a video
const musicSources = (query: string, song: boolean) =>
  Effect.gen(function* () {
    const response = yield* getJson(
      HttpClientRequest.post("https://music.youtube.com/youtubei/v1/search").pipe(
        HttpClientRequest.setUrlParam("prettyPrint", "false"),
        HttpClientRequest.bodyJsonUnsafe({
          context: { client: remix },
          query,
          params: song ? songsOnly : videosOnly,
        }),
      ),
      MusicSearch,
    ).pipe(
      Effect.mapError(
        (error) =>
          new ProviderError({
            reason:
              error instanceof HttpStatusError
                ? `YouTube Music answered status ${error.status}`
                : error.reason,
          }),
      ),
    );

    return response.contents.tabbedSearchResultsRenderer.tabs
      .flatMap((tab) => tab.tabRenderer.content.sectionListRenderer.contents)
      .flatMap((section) => section.musicShelfRenderer?.contents ?? [])
      .flatMap(({ musicResponsiveListItemRenderer: item }) => {
        if (item === undefined) return [];

        const [title = [], details = []] = item.flexColumns.map(
          (column) => column.musicResponsiveListItemFlexColumnRenderer.text.runs ?? [],
        );
        const duration = details.at(-1)?.text ?? "";
        // Podcast episodes and live streams have no duration
        if (item.playlistItemData === undefined || !/^\d+(:\d\d)+$/.test(duration)) return [];

        const credit = details.slice(
          0,
          details.findIndex((run) => run.text === " • "),
        );
        const channel = credit.find((run) => pageType(run) !== undefined);
        const channelId = channel?.navigationEndpoint?.browseEndpoint?.browseId;
        const [artwork] = item.thumbnail.musicThumbnailRenderer.thumbnail.thumbnails.toSorted(
          (a, b) => b.width - a.width,
        );
        const explicit = (item.badges ?? []).some(
          (badge) => badge.musicInlineBadgeRenderer?.icon.iconType === "MUSIC_EXPLICIT_BADGE",
        );
        return [
          new ProviderSource({
            externalId: item.playlistItemData.videoId,
            title: title.map((run) => run.text).join(""),
            artist:
              song || credit.some((run) => pageType(run) === "MUSIC_PAGE_TYPE_ARTIST")
                ? credit.map((run) => run.text).join("")
                : null,
            album: details.find((run) => pageType(run) === "MUSIC_PAGE_TYPE_ALBUM")?.text ?? null,
            durationMs: clockMs(duration),
            isrc: null,
            container: "webm",
            codec: "opus",
            lossless: false,
            encrypted: false,
            // Song covers are on `googleusercontent.com`, which scales to the size in the URL
            artworkUrl: artwork?.url.replace(/=w\d+-h\d+/, "=w544-h544") ?? null,
            artists: [],
            explicit: explicit || (song ? false : null),
            bitrate: opusBitrate,
            uploader:
              channel === undefined || channelId === undefined
                ? null
                : new CreditedArtist({ id: channelId, name: channel.text }),
            albumId: null,
          }),
        ];
      });
  });

/**
 * Songs and music videos of YouTube Music, then the long YouTube videos of their channels that
 * YouTube Music does not list, for example some Cercle and Boiler Room sets
 */
export const searchMusic = (query: string) =>
  Effect.gen(function* () {
    const [songs, videos, uploads] = yield* Effect.all(
      [musicSources(query, true), musicSources(query, false), searchVideos(query)],
      { concurrency: 3 },
    );
    // Other channels of long videos are often not music, for example travel or game videos
    const channels = new Set([...songs, ...videos].flatMap((source) => source.uploader?.id ?? []));
    const sets = uploads.filter(
      (source) =>
        (source.durationMs ?? 0) >= setMs &&
        source.uploader !== null &&
        channels.has(source.uploader.id),
    );

    const seen = new Set<string>();
    return Array.from({ length: Math.max(songs.length, videos.length, sets.length) }, (_, index) =>
      [songs[index], videos[index], sets[index]].flatMap((source) => {
        if (source === undefined || seen.has(source.externalId)) return [];
        seen.add(source.externalId);
        return [source];
      }),
    ).flat();
  });
