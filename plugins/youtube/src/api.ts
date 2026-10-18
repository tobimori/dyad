import {
  CreditedArtist,
  ProviderAudio,
  ProviderError,
  ProviderSource,
  ProviderTracklist,
  ProviderVideo,
} from "@dyad/plugin";
import { getJson, makeScrapedToken, providerError } from "@dyad/plugin/http";
import { clockMs, parseTracklist, tracklistEntry } from "@dyad/plugin/tracklist";
import { Cache, Duration, Effect, Exit, Option, Redacted, Schema, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

import { readChunks, streamError, webmStream } from "./webm.ts";

export const provider = "youtube";

const api = "https://www.youtube.com/youtubei/v1";

export const web = { clientName: "WEB", clientVersion: "2.20260623.01.00", hl: "en", gl: "US" };

// yt-dlp 2026.08.19: the only client whose audio URLs need no PO token and no player JavaScript.
// `ANDROID_VR` now needs a PO token.
const visionos = {
  clientName: "VISIONOS",
  clientVersion: "1.02",
  deviceMake: "Apple",
  deviceModel: "RealityDevice17,1",
  osName: "visionOS",
  osVersion: "26.5.23O471",
  hl: "en",
  gl: "US",
};

// The `params` of the web client's "Type: Video" search filter
const videosOnly = "EgIQAQ%3D%3D";

const Runs = Schema.Struct({ runs: Schema.Array(Schema.Struct({ text: Schema.String })) });

const VideoRenderer = Schema.Struct({
  videoId: Schema.String,
  title: Runs,
  ownerText: Schema.Struct({
    runs: Schema.Array(
      Schema.Struct({
        text: Schema.String,
        // Missing for a video of several channels
        navigationEndpoint: Schema.optional(
          Schema.Struct({
            browseEndpoint: Schema.optional(Schema.Struct({ browseId: Schema.String })),
          }),
        ),
      }),
    ),
  }),
  // Missing for live and upcoming streams
  lengthText: Schema.optional(Schema.Struct({ simpleText: Schema.String })),
  thumbnail: Schema.Struct({
    thumbnails: Schema.Array(Schema.Struct({ url: Schema.String, width: Schema.Finite })),
  }),
});

const SearchResults = Schema.Struct({
  contents: Schema.Struct({
    twoColumnSearchResultsRenderer: Schema.Struct({
      primaryContents: Schema.Struct({
        sectionListRenderer: Schema.Struct({
          contents: Schema.Array(
            Schema.Struct({
              itemSectionRenderer: Schema.optional(
                Schema.Struct({
                  contents: Schema.Array(
                    Schema.Struct({ videoRenderer: Schema.optional(VideoRenderer) }),
                  ),
                }),
              ),
            }),
          ),
        }),
      }),
    }),
  }),
});

const VisitorData = Schema.Struct({
  responseContext: Schema.Struct({ visitorData: Schema.String }),
});

const Range = Schema.Struct({ start: Schema.FiniteFromString, end: Schema.FiniteFromString });

// Other formats, for example video or AAC, do not decode as this schema and are skipped
const OpusFormat = Schema.Struct({
  url: Schema.String,
  mimeType: Schema.String.check(Schema.isStartingWith('audio/webm; codecs="opus"')),
  bitrate: Schema.Int,
  contentLength: Schema.FiniteFromString,
  indexRange: Range,
  // A copy with dynamic range compression
  isDrc: Schema.optional(Schema.Boolean),
  // Dubbed videos have one audio track per language
  audioTrack: Schema.optional(Schema.Struct({ audioIsDefault: Schema.Boolean })),
});

// HDR streams are `vp09.02…` with 10-bit samples, which this schema skips
const Vp9Format = Schema.Struct({
  url: Schema.String,
  mimeType: Schema.String.check(Schema.isStartingWith('video/webm; codecs="vp9"')),
  bitrate: Schema.Int,
  height: Schema.Int,
  contentLength: Schema.FiniteFromString,
  indexRange: Range,
});

const Player = Schema.Struct({
  playabilityStatus: Schema.Struct({
    status: Schema.String,
    reason: Schema.optional(Schema.String),
  }),
  streamingData: Schema.optional(Schema.Struct({ adaptiveFormats: Schema.Array(Schema.Unknown) })),
});

const Chapter = Schema.Struct({
  chapterRenderer: Schema.Struct({
    title: Schema.Struct({ simpleText: Schema.String }),
    timeRangeStartMillis: Schema.Int,
  }),
});

const Continuation = Schema.Struct({
  continuationItemRenderer: Schema.Struct({
    continuationEndpoint: Schema.Struct({
      continuationCommand: Schema.Struct({ token: Schema.String }),
    }),
  }),
});

// Each level is missing for some videos, for example a video without chapters or comments
const Next = Schema.Struct({
  contents: Schema.optional(
    Schema.Struct({
      twoColumnWatchNextResults: Schema.Struct({
        results: Schema.Struct({
          results: Schema.Struct({
            contents: Schema.Array(
              Schema.Struct({
                itemSectionRenderer: Schema.optional(
                  Schema.Struct({
                    sectionIdentifier: Schema.optional(Schema.String),
                    contents: Schema.Array(Schema.Unknown),
                  }),
                ),
                videoSecondaryInfoRenderer: Schema.optional(
                  Schema.Struct({
                    attributedDescription: Schema.optional(
                      Schema.Struct({ content: Schema.String }),
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
  playerOverlays: Schema.optional(
    Schema.Struct({
      playerOverlayRenderer: Schema.optional(
        Schema.Struct({
          decoratedPlayerBarRenderer: Schema.optional(
            Schema.Struct({
              decoratedPlayerBarRenderer: Schema.optional(
                Schema.Struct({
                  playerBar: Schema.optional(
                    Schema.Struct({
                      multiMarkersPlayerBarRenderer: Schema.optional(
                        Schema.Struct({
                          markersMap: Schema.optional(
                            Schema.Array(
                              Schema.Struct({
                                key: Schema.String,
                                value: Schema.Struct({
                                  chapters: Schema.optional(Schema.Array(Chapter)),
                                }),
                              }),
                            ),
                          ),
                        }),
                      ),
                    }),
                  ),
                }),
              ),
            }),
          ),
        }),
      ),
    }),
  ),
});

const CommentItems = Schema.Struct({
  continuationItems: Schema.optional(
    Schema.Array(
      Schema.Struct({
        commentThreadRenderer: Schema.optional(
          Schema.Struct({
            commentViewModel: Schema.Struct({
              commentViewModel: Schema.Struct({
                commentId: Schema.String,
                pinnedText: Schema.optional(Schema.String),
              }),
            }),
          }),
        ),
        continuationItemRenderer: Schema.optional(Continuation.fields.continuationItemRenderer),
      }),
    ),
  ),
});

// The comment texts are in `frameworkUpdates`; the threads only say which comment is pinned
const Comments = Schema.Struct({
  onResponseReceivedEndpoints: Schema.optional(
    Schema.Array(
      Schema.Struct({
        // The first page
        reloadContinuationItemsCommand: Schema.optional(CommentItems),
        appendContinuationItemsAction: Schema.optional(CommentItems),
      }),
    ),
  ),
  frameworkUpdates: Schema.optional(
    Schema.Struct({
      entityBatchUpdate: Schema.Struct({
        mutations: Schema.Array(
          Schema.Struct({
            payload: Schema.optional(
              Schema.Struct({
                commentEntityPayload: Schema.optional(
                  Schema.Struct({
                    properties: Schema.Struct({
                      commentId: Schema.String,
                      content: Schema.Struct({ content: Schema.String }),
                    }),
                    author: Schema.Struct({ isCreator: Schema.optional(Schema.Boolean) }),
                    // For example `198`, `5.7K` or `1.2M`
                    toolbar: Schema.Struct({ likeCountNotliked: Schema.optional(Schema.String) }),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    }),
  ),
});

const ExternalId = Schema.String.check(Schema.isPattern(/^[\w-]{11}$/));

const innertube = <S extends Schema.Constraint>(
  endpoint: string,
  client: typeof web | (typeof visionos & { readonly visitorData: string }),
  fields: {
    readonly videoId?: string;
    readonly continuation?: string;
    readonly query?: string;
    readonly params?: string;
    readonly contentCheckOk?: boolean;
    readonly racyCheckOk?: boolean;
  },
  schema: S,
) =>
  getJson(
    HttpClientRequest.post(`${api}/${endpoint}`).pipe(
      HttpClientRequest.setUrlParam("prettyPrint", "false"),
      HttpClientRequest.bodyJsonUnsafe({ context: { client }, ...fields }),
    ),
    schema,
  );

/**
 * An anonymous visitor ID. Without one, `/player` asks to sign in. It belongs to no account, so
 * all users share it for an hour.
 */
export const visitorCache = makeScrapedToken(
  innertube("visitor_id", web, {}, VisitorData).pipe(
    Effect.map((response) => Redacted.make(response.responseContext.visitorData)),
    Effect.mapError(providerError("YouTube")),
  ),
  { timeToLive: "1 hour", rejectedStatuses: [] },
);

const decodeVideoId = (externalId: string) =>
  Schema.decodeEffect(ExternalId)(externalId).pipe(
    Effect.mapError(() => new ProviderError({ reason: "Invalid video ID" })),
  );

const readPlayer = (withVisitor: Effect.Success<typeof visitorCache>, videoId: string) =>
  Effect.gen(function* () {
    const player = yield* withVisitor((visitorData) =>
      innertube(
        "player",
        { ...visionos, visitorData: Redacted.value(visitorData) },
        { videoId, contentCheckOk: true, racyCheckOk: true },
        Player,
      ),
    ).pipe(
      Effect.catchTags({
        HttpStatusError: (error) => Effect.fail(providerError("YouTube")(error)),
        HttpRequestError: (error) => Effect.fail(providerError("YouTube")(error)),
      }),
    );

    if (player.playabilityStatus.status !== "OK") {
      return yield* new ProviderError({
        reason: `YouTube does not play the video: ${player.playabilityStatus.reason ?? player.playabilityStatus.status}`,
      });
    }
    return player;
  });

// The URLs expire after 6 hours (October 2026), so a stream that starts from a cached answer
// still has 5 hours
const playerLifetime = "1 hour";

/**
 * The `/player` answers by video ID. Each call can get the bot check, so the audio and the video
 * of a video share one answer. Failures are not cached.
 */
export const playerCache = (withVisitor: Effect.Success<typeof visitorCache>) =>
  Cache.makeWith((videoId: string) => readPlayer(withVisitor, videoId), {
    capacity: 256,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? playerLifetime : Duration.zero),
  });

type Players = Effect.Success<ReturnType<typeof playerCache>>;

const adaptiveFormats = <S extends Schema.ConstraintDecoder<unknown>>(
  players: Players,
  externalId: string,
  schema: S,
) =>
  Effect.gen(function* () {
    const player = yield* Cache.get(players, yield* decodeVideoId(externalId));
    return (player.streamingData?.adaptiveFormats ?? []).flatMap((item) =>
      Option.toArray(Schema.decodeUnknownOption(schema)(item)),
    );
  });

// Itag 251, which nearly every video has, is Opus of up to 160 kbit/s
const opusBitrate = 160_000;

/** Videos in YouTube's order of relevance, without live streams */
export const searchVideos = (query: string) =>
  Effect.gen(function* () {
    const response = yield* innertube(
      "search",
      web,
      { query, params: videosOnly },
      SearchResults,
    ).pipe(Effect.mapError(providerError("YouTube")));

    return response.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents.flatMap(
      (section) =>
        (section.itemSectionRenderer?.contents ?? []).flatMap(({ videoRenderer: video }) => {
          if (video === undefined || video.lengthText === undefined) return [];

          const channel = video.ownerText.runs[0];
          const channelId = channel?.navigationEndpoint?.browseEndpoint?.browseId;
          const artwork = video.thumbnail.thumbnails.toSorted((a, b) => b.width - a.width)[0];
          return [
            new ProviderSource({
              externalId: video.videoId,
              title: video.title.runs.map((run) => run.text).join(""),
              // YouTube makes `<Artist> - Topic` channels for the releases of an artist
              artist: channel?.text.replace(/ - Topic$/, "") ?? null,
              album: null,
              durationMs: clockMs(video.lengthText.simpleText),
              isrc: null,
              container: "webm",
              codec: "opus",
              lossless: false,
              encrypted: false,
              artworkUrl: artwork?.url ?? null,
              artists: [],
              explicit: null,
              bitrate: opusBitrate,
              uploader:
                channel === undefined || channelId === undefined
                  ? null
                  : new CreditedArtist({ id: channelId, name: channel.text }),
              albumId: null,
              video: true,
            }),
          ];
        }),
    );
  });

const playerStream = (
  format: {
    readonly url: string;
    readonly contentLength: number;
    readonly indexRange: { readonly start: number; readonly end: number };
  },
  kind: "audio" | "video",
) =>
  Effect.gen(function* () {
    // October 2026: `/player` can give this server URLs that answer 403. One byte shows it before
    // the play starts, so that the plugin can switch to yt-dlp.
    yield* Stream.runDrain(readChunks(format.url, 0, 1)).pipe(Effect.mapError(streamError(kind)));
    // `indexRange` includes its end byte
    return yield* webmStream(format.url, format.contentLength, kind, {
      start: format.indexRange.start,
      end: format.indexRange.end + 1,
    });
  });

/** Streams the Opus audio of a video in its WebM file */
export const resolveAudio = (players: Players, externalId: string) =>
  Effect.gen(function* () {
    const format = (yield* adaptiveFormats(players, externalId, OpusFormat))
      .filter((item) => item.isDrc !== true && item.audioTrack?.audioIsDefault !== false)
      .toSorted((a, b) => b.bitrate - a.bitrate)[0];
    if (format === undefined) {
      return yield* new ProviderError({ reason: "The video has no Opus audio" });
    }
    return new ProviderAudio(yield* playerStream(format, "audio"));
  });

/** Of streams with equal height, the lowest bitrate wins, which skips 60 fps streams */
export const resolveVideo = (players: Players, externalId: string, maxHeight: number) =>
  Effect.gen(function* () {
    const formats = (yield* adaptiveFormats(players, externalId, Vp9Format)).toSorted(
      (a, b) => b.height - a.height || a.bitrate - b.bitrate,
    );
    const format = formats.find((item) => item.height <= maxHeight) ?? formats.at(-1);
    if (format === undefined) {
      return yield* new ProviderError({ reason: "The video has no VP9 stream" });
    }
    return new ProviderVideo(yield* playerStream(format, "video"));
  });

// YouTube makes chapters from the description. `AUTO_CHAPTERS` are topics, not tracks.
const descriptionChapters = "DESCRIPTION_CHAPTERS";

// YouTube needs three chapters too; fewer times in a description are rarely a tracklist
const minimumEntries = 3;

// Many comments list favorite moments by time. A tracklist also names artists.
const minimumCommentTracks = 5;

const units = { K: 1e3, M: 1e6 };

const likeCount = (text: string | undefined) => {
  const [, digits, unit] = text?.match(/^([\d.]+)([KM]?)$/) ?? [];
  return Number(digits ?? 0) * (unit === "K" || unit === "M" ? units[unit] : 1);
};

// The order of top comments changes between requests, so the plugin reads some pages
const commentPages = 3;

// The pinned comment, then comments of the uploader, then the most likes
const commentTracklist = (next: typeof Next.Type) =>
  Effect.gen(function* () {
    const first = next.contents?.twoColumnWatchNextResults.results.results.contents
      .find((content) => content.itemSectionRenderer?.sectionIdentifier === "comment-item-section")
      ?.itemSectionRenderer?.contents.flatMap((item) =>
        Option.toArray(Schema.decodeUnknownOption(Continuation)(item)),
      )[0]?.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    if (first === undefined) return [];

    const pages = yield* Stream.paginate(first, (token) =>
      innertube("next", web, { continuation: token }, Comments).pipe(
        Effect.mapError(providerError("YouTube")),
        Effect.map((page) => {
          const items = (page.onResponseReceivedEndpoints ?? []).flatMap(
            (endpoint) =>
              (endpoint.reloadContinuationItemsCommand ?? endpoint.appendContinuationItemsAction)
                ?.continuationItems ?? [],
          );
          const following =
            items.at(-1)?.continuationItemRenderer?.continuationEndpoint.continuationCommand.token;
          return [[{ page, items }], Option.fromUndefinedOr(following)] as const;
        }),
      ),
    ).pipe(Stream.take(commentPages), Stream.runCollect);

    const pinned = new Set(
      pages.flatMap(({ items }) =>
        items.flatMap((item) => {
          const comment = item.commentThreadRenderer?.commentViewModel.commentViewModel;
          return comment?.pinnedText === undefined ? [] : [comment.commentId];
        }),
      ),
    );

    const [best] = pages
      .flatMap(({ page }) => page.frameworkUpdates?.entityBatchUpdate.mutations ?? [])
      .flatMap(({ payload }) => {
        const comment = payload?.commentEntityPayload;
        if (comment === undefined) return [];

        const entries = parseTracklist(comment.properties.content.content);
        if (entries.filter((entry) => entry.artist !== null).length < minimumCommentTracks) {
          return [];
        }
        const id = comment.properties.commentId;
        return [
          {
            id,
            entries,
            pinned: pinned.has(id) ? 1 : 0,
            creator: comment.author.isCreator === true ? 1 : 0,
            likes: likeCount(comment.toolbar.likeCountNotliked),
          },
        ];
      })
      .toSorted((a, b) => b.pinned - a.pinned || b.creator - a.creator || b.likes - a.likes);
    return best === undefined
      ? []
      : [
          new ProviderTracklist({
            part: `comment:${best.id}`,
            entries: best.entries,
            confidence: 0.6,
          }),
        ];
  });

/**
 * The chapters, the timed lines of the description and the best tracklist in the comments. All
 * come from the web client's `/next`, which has no bot check like `/player`.
 */
export const videoTracklists = (externalId: string) =>
  Effect.gen(function* () {
    const videoId = yield* decodeVideoId(externalId);
    const next = yield* innertube("next", web, { videoId }, Next).pipe(
      Effect.mapError(providerError("YouTube")),
    );

    const chapters = (
      next.playerOverlays?.playerOverlayRenderer?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar?.multiMarkersPlayerBarRenderer?.markersMap?.find(
        (marker) => marker.key === descriptionChapters,
      )?.value.chapters ?? []
    ).flatMap(({ chapterRenderer: chapter }) => {
      const entry = tracklistEntry(chapter.title.simpleText, chapter.timeRangeStartMillis);
      return entry === undefined ? [] : [entry];
    });
    const description = parseTracklist(
      next.contents?.twoColumnWatchNextResults.results.results.contents.find(
        (content) => content.videoSecondaryInfoRenderer !== undefined,
      )?.videoSecondaryInfoRenderer?.attributedDescription?.content ?? "",
    );

    return [
      new ProviderTracklist({ part: "chapters", entries: chapters, confidence: 0.9 }),
      new ProviderTracklist({ part: "description", entries: description, confidence: 0.8 }),
    ]
      .filter((tracklist) => tracklist.entries.length >= minimumEntries)
      .concat(yield* commentTracklist(next));
  });

const youtubeHosts = new Set([
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  "music.youtube.com",
]);
const channelId = /^UC[\w-]{22}$/;

/**
 * The channel ID of a `/channel/UC…` URL, without a request. Handles and `/user/` URLs need a
 * request to YouTube, so they give `null`.
 */
export const channelFromUrl = (url: string) => {
  const parsed = URL.parse(url);
  if (parsed === null || !youtubeHosts.has(parsed.hostname)) return null;

  const [kind, id] = parsed.pathname.split("/").filter((part) => part !== "");
  return kind === "channel" && id !== undefined && channelId.test(id) ? id : null;
};
