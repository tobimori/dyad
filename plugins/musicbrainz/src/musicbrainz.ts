import { CreditedArtist, MusicBrainzRecording } from "@dyad/plugin";
import { Array as Arr, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { requestJson } from "./http.ts";

const searchUrl = "https://musicbrainz.org/ws/2/recording";

// 100 is the largest page of the search. 25 ISRCs per query leave room for ISRCs with several
// recordings.
const pageSize = 100;
const batchSize = 25;

const Isrc = Schema.String.check(Schema.isPattern(/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/));

const ArtistCredit = Schema.Struct({
  name: Schema.String,
  joinphrase: Schema.optional(Schema.String),
  artist: Schema.Struct({ id: Schema.String, name: Schema.String }),
});

class SearchRecording extends Schema.Class<SearchRecording>("SearchRecording")({
  id: Schema.String,
  title: Schema.String,
  length: Schema.optional(Schema.NullOr(Schema.Int)),
  isrcs: Schema.optional(Schema.Array(Schema.String)),
  "artist-credit": Schema.optional(Schema.Array(ArtistCredit)),
}) {}

const SearchResults = Schema.Struct({
  count: Schema.Int,
  recordings: Schema.Array(SearchRecording),
});

const toRecording = (recording: SearchRecording) => {
  const credit = recording["artist-credit"] ?? [];
  return new MusicBrainzRecording({
    mbid: recording.id,
    title: recording.title,
    artist:
      credit.length === 0
        ? null
        : credit.map((name) => `${name.name}${name.joinphrase ?? ""}`).join(""),
    artists: credit.map(
      (name) => new CreditedArtist({ id: name.artist.id, name: name.artist.name }),
    ),
    durationMs: recording.length ?? null,
  });
};

const searchPage = (query: string, offset: number) =>
  requestJson(
    "musicbrainz",
    HttpClientRequest.get(searchUrl).pipe(
      HttpClientRequest.setUrlParams({ query, limit: pageSize, offset, fmt: "json" }),
    ),
    SearchResults,
  );

const searchBatch = Effect.fn("searchBatch")(function* (isrcs: ReadonlyArray<string>) {
  const query = isrcs.map((isrc) => `isrc:${isrc}`).join(" OR ");

  const first = yield* searchPage(query, 0);
  const recordings = [...first.recordings];

  for (let offset = pageSize; offset < first.count; offset += pageSize) {
    const page = yield* searchPage(query, offset);
    recordings.push(...page.recordings);
  }

  return recordings;
});

/**
 * Finds the MusicBrainz recordings of each ISRC, with one search request for up to 25 ISRCs. The
 * result has an entry for each ISRC, with an empty array when no recording has it.
 */
export const lookupIsrcs = Effect.fn("lookupIsrcs")(function* (isrcs: ReadonlyArray<string>) {
  const valid = Arr.dedupe(isrcs).filter(Schema.is(Isrc));
  const batches = yield* Effect.forEach(Arr.chunksOf(valid, batchSize), searchBatch);

  // A recording with ISRCs in two batches comes back twice
  const recordings = new Map(batches.flat().map((recording) => [recording.id, recording]));

  // The search answers the recordings of all ISRCs of a query, and its index can lag behind the
  // database. Only the `isrcs` of a recording show which ISRCs it has now.
  const recordingsOf = (isrc: string) =>
    [...recordings.values()].flatMap((recording) => {
      if (recording.isrcs?.includes(isrc) !== true) return [];

      return [toRecording(recording)];
    });

  return new Map(isrcs.map((isrc) => [isrc, recordingsOf(isrc)]));
});

// Inside a Lucene phrase, only `"` and `\` need an escape
const phrase = (text: string) => `"${text.replaceAll(/["\\]/g, "\\$&")}"`;

// Words instead of a phrase, because a free-text credit such as `Argy, Omnya` rarely has the
// separators of the MusicBrainz credit. Lowercase, because `AND` and `OR` are operators.
const words = (text: string) =>
  `(${text
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim()})`;

// The recording search also finds other versions of the song, so the core checks the title
const textCandidates = 5;

/** The best recordings of the MusicBrainz search for one artist and title */
export const searchRecording = (artist: string, title: string) =>
  requestJson(
    "musicbrainz",
    HttpClientRequest.get(searchUrl).pipe(
      HttpClientRequest.setUrlParams({
        query: `recording:${phrase(title)} AND artist:${words(artist)}`,
        limit: textCandidates,
        fmt: "json",
      }),
    ),
    SearchResults,
  ).pipe(Effect.map((results) => results.recordings.map(toRecording)));

const ArtistRelations = Schema.Struct({
  relations: Schema.Array(
    Schema.Struct({
      ended: Schema.optional(Schema.Boolean),
      url: Schema.optional(Schema.Struct({ resource: Schema.String })),
    }),
  ),
});

/** The URLs of the relations of an artist that have not ended. Empty for an unknown MBID. */
export const artistUrls = (mbid: string) =>
  requestJson(
    "musicbrainz",
    HttpClientRequest.get(`https://musicbrainz.org/ws/2/artist/${encodeURIComponent(mbid)}`).pipe(
      HttpClientRequest.setUrlParams({ inc: "url-rels", fmt: "json" }),
    ),
    ArtistRelations,
  ).pipe(
    Effect.map((artist) =>
      Arr.dedupe(
        artist.relations.flatMap((relation) =>
          relation.ended === true || relation.url === undefined ? [] : [relation.url.resource],
        ),
      ),
    ),
    Effect.catchTag("LookupError", (error) =>
      error.status === 404 ? Effect.succeed([]) : Effect.fail(error),
    ),
  );
