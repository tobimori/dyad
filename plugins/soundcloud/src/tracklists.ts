import { ProviderTracklist } from "@dyad/plugin";
import { parseTracklist, parseUntimedTracklist } from "@dyad/plugin/tracklist";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { api, decodeTrackId, requestApi } from "./api.ts";
import type { clientIdCache } from "./api.ts";

const TrackText = Schema.Struct({
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  user: Schema.Struct({ id: Schema.Int }),
});

const Comments = Schema.Struct({
  collection: Schema.Array(
    Schema.Struct({ id: Schema.Int, body: Schema.String, user_id: Schema.Int }),
  ),
});

// Fewer times in a description are rarely a tracklist
const minimumTimed = 3;
// Lines of links and credits also look like `Name - Text`, so a list without times needs more
const minimumUntimed = 5;
// Many comments list favorite moments by time. A tracklist also names artists.
const minimumCommentTracks = 5;
// One page of comments. Popular sets have thousands.
const commentLimit = 200;

// Most set descriptions list the tracks without times. Such a list shows the tracks and finds
// their recordings, but a timed comment is better, because it lets the player seek.
const descriptionTracklist = (track: typeof TrackText.Type) => {
  const description = track.description ?? "";
  const timed = parseTracklist(description);
  if (timed.length >= minimumTimed) {
    return [new ProviderTracklist({ part: "description", entries: timed, confidence: 0.8 })];
  }
  // Descriptions often start with the title of the set, which looks like a track
  const untimed = parseUntimedTracklist(description).filter(
    (entry) => `${entry.artist} - ${entry.title}` !== track.title.trim(),
  );
  return untimed.length < minimumUntimed
    ? []
    : [new ProviderTracklist({ part: "description", entries: untimed, confidence: 0.5 })];
};

/** The tracklist in the description and the best timed tracklist in the comments */
export const trackTracklists = (
  withClientId: Effect.Success<typeof clientIdCache>,
  externalId: string,
) =>
  Effect.gen(function* () {
    const trackId = yield* decodeTrackId(externalId);
    const [track, comments] = yield* Effect.all(
      [
        requestApi(withClientId, HttpClientRequest.get(`${api}/tracks/${trackId}`), TrackText),
        requestApi(
          withClientId,
          HttpClientRequest.get(`${api}/tracks/${trackId}/comments`).pipe(
            HttpClientRequest.setUrlParams({ threaded: 0, limit: commentLimit }),
          ),
          Comments,
        ),
      ],
      { concurrency: 2 },
    );

    // Comments of the uploader first, then the longest list
    const [best] = comments.collection
      .flatMap((comment) => {
        const entries = parseTracklist(comment.body);
        const tracks = entries.filter((entry) => entry.artist !== null).length;
        const own = comment.user_id === track.user.id ? 1 : 0;
        return tracks < minimumCommentTracks ? [] : [{ id: comment.id, entries, own }];
      })
      .toSorted((a, b) => b.own - a.own || b.entries.length - a.entries.length);

    return [
      ...descriptionTracklist(track),
      ...(best === undefined
        ? []
        : [
            new ProviderTracklist({
              part: `comment:${best.id}`,
              entries: best.entries,
              confidence: 0.6,
            }),
          ]),
    ];
  });
