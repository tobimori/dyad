import { Suggestion, SuggestionShelf } from "@dyad/plugin";
import type { Credentials, ProviderSource, RadioSeed } from "@dyad/plugin";
import { getJson, providerError } from "@dyad/plugin/http";
import { clockMs } from "@dyad/plugin/tracklist";
import { Effect, Option, Schema } from "effect";
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

// Only the title text: a title can link to a page without the configs of `Run`
const Shelf = Schema.Struct({
  header: Schema.optional(
    Schema.Struct({
      musicCarouselShelfBasicHeaderRenderer: Schema.Struct({
        title: Schema.Struct({ runs: Schema.Array(Schema.Struct({ text: Schema.String })) }),
      }),
    }),
  ),
  contents: Schema.Array(
    Schema.Struct({ musicResponsiveListItemRenderer: Schema.optional(ListItem) }),
  ),
});

// Each shelf decodes alone, so that a shelf in an unknown form drops only itself
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
                    // Other sections, for example a mood list, are not carousels
                    Schema.Struct({ musicCarouselShelfRenderer: Schema.optional(Schema.Unknown) }),
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
const watchPlaylist = Effect.fnUntraced(function* (videoId: string) {
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
        tab.tabRenderer.content?.musicQueueRenderer?.content?.playlistPanelRenderer.contents ?? [],
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
export const youtubeRadio = Effect.fn("youtubeRadio")(function* (seed: RadioSeed) {
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
export const youtubeShelves = Effect.fn("youtubeShelves")(function* (credentials: Credentials) {
  const response = yield* getJson(
    HttpClientRequest.post(`${music}/youtubei/v1/browse`).pipe(
      HttpClientRequest.setUrlParam("prettyPrint", "false"),
      HttpClientRequest.setHeaders(yield* accountHeaders(credentials, music)),
      HttpClientRequest.bodyJsonUnsafe({ context: { client: remix }, browseId: "FEmusic_home" }),
    ),
    Home,
  ).pipe(Effect.mapError(providerError("YouTube Music")));

  const sections = response.contents.singleColumnBrowseResultsRenderer.tabs.flatMap(
    (tab) => tab.tabRenderer.content?.sectionListRenderer.contents ?? [],
  );
  const decoded = sections.flatMap(({ musicCarouselShelfRenderer: shelf }) =>
    shelf === undefined ? [] : [Schema.decodeUnknownOption(Shelf)(shelf)],
  );
  const shelves = decoded.flatMap(Option.toArray);
  if (shelves.length < decoded.length) {
    yield* Effect.logWarning(`Skipped ${decoded.length - shelves.length} home shelves`);
  }

  return shelves.flatMap((shelf) => {
    const title = shelf.header?.musicCarouselShelfBasicHeaderRenderer.title.runs
      .map((run) => run.text)
      .join("");
    const songs = shelf.contents.flatMap(({ musicResponsiveListItemRenderer: item }) => {
      const source = item === undefined ? undefined : listItemSource(item, true);
      return source === undefined ? [] : [suggest(source)];
    });
    return title === undefined || songs.length === 0
      ? []
      : [new SuggestionShelf({ title, songs, releases: [] })];
  });
});
