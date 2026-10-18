import { Suggestion, SuggestionShelf } from "@dyad/plugin";
import type { Credentials, ProviderSource, RadioSeed } from "@dyad/plugin";
import { getJson, providerError } from "@dyad/plugin/http";
import { clockMs } from "@dyad/plugin/tracklist";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { accountHeaders } from "./login.ts";
import {
  ListItem,
  Run,
  listItemSource,
  musicSource,
  musicSources,
  pageType,
  remix,
} from "./search.ts";

const music = "https://music.youtube.com";

const Runs = Schema.Struct({ runs: Schema.Array(Run) });

const PanelVideo = Schema.Struct({
  videoId: Schema.String,
  title: Runs,
  longBylineText: Runs,
  // Missing for live streams
  lengthText: Schema.optional(Runs),
  thumbnail: Schema.Struct({
    thumbnails: Schema.Array(Schema.Struct({ url: Schema.String, width: Schema.Finite })),
  }),
  navigationEndpoint: Schema.Struct({
    watchEndpoint: Schema.optional(
      Schema.Struct({
        watchEndpointMusicSupportedConfigs: Schema.optional(
          Schema.Struct({
            watchEndpointMusicConfig: Schema.Struct({
              musicVideoType: Schema.optional(Schema.String),
            }),
          }),
        ),
      }),
    ),
  }),
});

// A song with a music video comes in a wrapper with both versions
const WatchPlaylist = Schema.Struct({
  contents: Schema.Struct({
    singleColumnMusicWatchNextResultsRenderer: Schema.Struct({
      tabbedRenderer: Schema.Struct({
        watchNextTabbedResultsRenderer: Schema.Struct({
          tabs: Schema.Array(
            Schema.Struct({
              tabRenderer: Schema.Struct({
                content: Schema.optional(
                  Schema.Struct({
                    // Only on the first tab
                    musicQueueRenderer: Schema.optional(
                      Schema.Struct({
                        content: Schema.optional(
                          Schema.Struct({
                            playlistPanelRenderer: Schema.Struct({
                              contents: Schema.Array(
                                Schema.Struct({
                                  playlistPanelVideoRenderer: Schema.optional(PanelVideo),
                                  playlistPanelVideoWrapperRenderer: Schema.optional(
                                    Schema.Struct({
                                      primaryRenderer: Schema.Struct({
                                        playlistPanelVideoRenderer: Schema.optional(PanelVideo),
                                      }),
                                    }),
                                  ),
                                }),
                              ),
                            }),
                          }),
                        ),
                      }),
                    ),
                  }),
                ),
              }),
            }),
          ),
        }),
      }),
    }),
  }),
});

const Home = Schema.Struct({
  contents: Schema.Struct({
    singleColumnBrowseResultsRenderer: Schema.Struct({
      tabs: Schema.Array(
        Schema.Struct({
          tabRenderer: Schema.Struct({
            content: Schema.optional(
              Schema.Struct({
                sectionListRenderer: Schema.Struct({
                  contents: Schema.Array(
                    Schema.Struct({
                      musicCarouselShelfRenderer: Schema.optional(
                        Schema.Struct({
                          header: Schema.optional(
                            Schema.Struct({
                              musicCarouselShelfBasicHeaderRenderer: Schema.Struct({
                                title: Runs,
                              }),
                            }),
                          ),
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
            ),
          }),
        }),
      ),
    }),
  }),
});

const suggest = (source: ProviderSource) =>
  new Suggestion({
    title: source.title,
    artist: source.artist ?? source.uploader?.name ?? "",
    source,
  });

/**
 * The radio of YouTube Music after a video: the `RDAMVM` watch playlist, without an account. The
 * playlist starts with the seed itself.
 */
const watchPlaylist = (videoId: string) =>
  Effect.gen(function* () {
    const response = yield* getJson(
      HttpClientRequest.post(`${music}/youtubei/v1/next`).pipe(
        HttpClientRequest.setUrlParam("prettyPrint", "false"),
        HttpClientRequest.bodyJsonUnsafe({
          context: { client: remix },
          videoId,
          playlistId: `RDAMVM${videoId}`,
          isAudioOnly: true,
          enablePersistentPlaylistPanel: true,
        }),
      ),
      WatchPlaylist,
    ).pipe(Effect.mapError(providerError("YouTube Music")));

    return response.contents.singleColumnMusicWatchNextResultsRenderer.tabbedRenderer.watchNextTabbedResultsRenderer.tabs
      .flatMap(
        (tab) =>
          tab.tabRenderer.content?.musicQueueRenderer?.content?.playlistPanelRenderer.contents ??
          [],
      )
      .flatMap((item) => {
        const video =
          item.playlistPanelVideoRenderer ??
          item.playlistPanelVideoWrapperRenderer?.primaryRenderer.playlistPanelVideoRenderer;
        const length = video?.lengthText?.runs[0]?.text;
        if (video === undefined || length === undefined || video.videoId === videoId) return [];

        const byline = video.longBylineText.runs;
        const type =
          video.navigationEndpoint.watchEndpoint?.watchEndpointMusicSupportedConfigs
            ?.watchEndpointMusicConfig.musicVideoType;
        return [
          suggest(
            musicSource({
              videoId: video.videoId,
              title: video.title.runs,
              byline,
              album: byline.find((run) => pageType(run) === "MUSIC_PAGE_TYPE_ALBUM")?.text ?? null,
              durationMs: clockMs(length),
              thumbnails: video.thumbnail.thumbnails,
              explicit: false,
              song: type === "MUSIC_VIDEO_TYPE_ATV",
              videoType: type,
            }),
          ),
        ];
      });
  });

/** One request for a seed on YouTube, else one songs search and one request */
export const youtubeRadio = (seed: RadioSeed) =>
  Effect.gen(function* () {
    if (seed.externalId !== null) return yield* watchPlaylist(seed.externalId);

    const [first] = yield* musicSources(
      seed.title === null ? seed.artist : `${seed.artist} ${seed.title}`,
      true,
    );
    return first === undefined ? [] : yield* watchPlaylist(first.externalId);
  });

/**
 * The song shelves of the YouTube Music home of the account, for example `Quick picks`. Mixes and
 * playlists need one more request each, so they are left out.
 */
export const youtubeShelves = (credentials: Credentials) =>
  Effect.gen(function* () {
    const response = yield* getJson(
      HttpClientRequest.post(`${music}/youtubei/v1/browse`).pipe(
        HttpClientRequest.setUrlParam("prettyPrint", "false"),
        HttpClientRequest.setHeaders(yield* accountHeaders(credentials, music)),
        HttpClientRequest.bodyJsonUnsafe({ context: { client: remix }, browseId: "FEmusic_home" }),
      ),
      Home,
    ).pipe(Effect.mapError(providerError("YouTube Music")));

    return response.contents.singleColumnBrowseResultsRenderer.tabs
      .flatMap((tab) => tab.tabRenderer.content?.sectionListRenderer.contents ?? [])
      .flatMap(({ musicCarouselShelfRenderer: shelf }) => {
        const title = shelf?.header?.musicCarouselShelfBasicHeaderRenderer.title.runs
          .map((run) => run.text)
          .join("");
        const songs = (shelf?.contents ?? []).flatMap(
          ({ musicResponsiveListItemRenderer: item }) => {
            const source = item === undefined ? undefined : listItemSource(item, true);
            return source === undefined ? [] : [suggest(source)];
          },
        );
        return title === undefined || songs.length === 0
          ? []
          : [new SuggestionShelf({ title, songs, releases: [] })];
      });
  });
