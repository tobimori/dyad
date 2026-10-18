import { CreditedArtist, MusicBrainzRecording } from "@dyad/plugin";
import { Array as Arr, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { requestJson } from "./http.ts";

// Labs endpoints are experimental and have no SLA (October 2026)
const acrLookupUrl = "https://labs.api.listenbrainz.org/acr-lookup/json";
const mbidLookupUrl = "https://labs.api.listenbrainz.org/recording-mbid-lookup/json";

// `acr-lookup` accepts up to 60 items per request
const batchSize = 50;

class AcrMatch extends Schema.Class<AcrMatch>("AcrMatch")({
  index: Schema.Int,
  recording_mbid: Schema.String,
  recording_name: Schema.String,
  artist_credit_name: Schema.String,
  artist_mbids: Schema.Array(Schema.String),
}) {}

// All fields except `original_recording_mbid` are `null` for an unknown MBID
class RecordingDetails extends Schema.Class<RecordingDetails>("RecordingDetails")({
  original_recording_mbid: Schema.String,
  canonical_recording_mbid: Schema.NullOr(Schema.String),
  recording_name: Schema.NullOr(Schema.String),
  length: Schema.NullOr(Schema.Int),
}) {}

// `acr-lookup` ignores case and answers duplicate items only once, with the last index
const pairKey = (pair: { readonly artist: string; readonly title: string }) =>
  JSON.stringify([pair.artist.toLowerCase(), pair.title.toLowerCase()]);

const lookupBatch = (pairs: ReadonlyArray<{ readonly artist: string; readonly title: string }>) =>
  Effect.gen(function* () {
    const acrRequest = HttpClientRequest.post(acrLookupUrl).pipe(
      HttpClientRequest.bodyJsonUnsafe(
        pairs.map((pair) => ({ artist_credit_name: pair.artist, recording_name: pair.title })),
      ),
    );
    const matches = yield* requestJson("listenbrainz", acrRequest, Schema.Array(AcrMatch));
    if (matches.length === 0) return [];

    // `acr-lookup` has no length and does not say if its recording is the canonical one
    const detailsRequest = HttpClientRequest.post(mbidLookupUrl).pipe(
      HttpClientRequest.bodyJsonUnsafe(
        matches.map((match) => ({ recording_mbid: match.recording_mbid })),
      ),
    );
    const details = yield* requestJson(
      "listenbrainz",
      detailsRequest,
      Schema.Array(RecordingDetails),
    );
    const detailsByMbid = new Map(
      details.map((detail) => [detail.original_recording_mbid, detail]),
    );

    return matches.flatMap((match) => {
      const pair = pairs[match.index];
      if (pair === undefined) return [];

      const detail = detailsByMbid.get(match.recording_mbid);
      const hit = new MusicBrainzRecording({
        mbid: detail?.canonical_recording_mbid ?? match.recording_mbid,
        title: detail?.recording_name ?? match.recording_name,
        artist: match.artist_credit_name,
        // The answer has no name for each MBID of a credit with several artists
        artists:
          match.artist_mbids.length === 1
            ? match.artist_mbids.map(
                (id) => new CreditedArtist({ id, name: match.artist_credit_name }),
              )
            : [],
        durationMs: detail?.length ?? null,
      });
      return [[pairKey(pair), hit] as const];
    });
  });

/**
 * Finds the canonical recording of each artist credit and title with the ListenBrainz labs API. The
 * match is exact except for case. The result has no entry for a key without a match.
 */
export const lookupRecordings = (
  inputs: ReadonlyArray<{ readonly key: string; readonly artist: string; readonly title: string }>,
) =>
  Effect.gen(function* () {
    const pairs = new Map(inputs.map((input) => [pairKey(input), input]));
    const batches = yield* Effect.forEach(
      Arr.chunksOf([...pairs.values()], batchSize),
      lookupBatch,
    );
    const hits = new Map(batches.flat());

    return new Map(
      inputs.flatMap((input) => {
        const hit = hits.get(pairKey(input));
        return hit === undefined ? [] : [[input.key, hit] as const];
      }),
    );
  });
