import type { SourceSummary } from "@dyad/domain";
import type { PopularityHit } from "@dyad/plugin";
import { Data } from "effect";

import { normalizeArtist, normalizeText, normalizeTitle, simplifyText } from "./normalize.ts";

/** One search result of a provider or of this replica, before grouping */
export class Candidate extends Data.Class<{
  readonly summary: SourceSummary;
  /** Normalized with `normalizeIsrc` */
  readonly isrc: string | null;
  /** Position in the result list of its provider, from 0 */
  readonly position: number;
  /** A file on this replica */
  readonly local: boolean;
  readonly lossless: boolean;
}> {}

/** One play of the user who searches */
export class Play extends Data.Class<{
  readonly sourceId: string;
  /** Normalized with `normalizeIsrc` */
  readonly isrc: string | null;
  readonly artist: string | null;
  readonly startedAt: number;
  readonly playedMs: number;
  readonly completed: boolean;
}> {}

/** The parts of the score of one result, before the weights apply */
class Score extends Data.Class<{
  /** 1 for an exact title, artist or "artist title" match, less for some matching words */
  readonly match: number;
  /** 1 when the result is a cover, remix or other version that the query does not ask for */
  readonly otherVersion: number;
  /** From the popularity sources, or from the provider position when they do not know it */
  readonly popularity: number;
  /** From -1 to 1: recent plays of the same recording, less skips */
  readonly recordingPlays: number;
  /** From -1 to 1: recent plays of the same artist, less skips */
  readonly artistPlays: number;
  readonly total: number;
}> {}

class RankedResult extends Data.Class<{
  readonly summary: SourceSummary;
  readonly score: Score;
}> {}

// Tune the ranking here
const weights = {
  match: 1,
  otherVersion: -0.5,
  popularity: 1,
  recordingPlays: 0.8,
  artistPlays: 0.4,
};

// A query with only some matching words gets this part of an exact match when all words match
const partialMatch = 0.7;

// Popularity of the first result of a provider when no popularity source knows it. The value
// decreases with the position, so the provider's own order stays.
const positionPopularity = 0.3;

const halfLifeMs = 30 * 24 * 60 * 60 * 1000;

// A play that is shorter and not completed is a skip
const listenMs = 30_000;

// A recent skip counts against the recording as much as half a recent listen counts for it
const skipValue = -0.5;

/** Older plays weigh less than 1/4096 and do not change the ranking */
export const playHistoryMs = 12 * halfLifeMs;

// Words that mark another version of a song. A query that contains one asks for that version.
const versionMarkers = [
  "cover",
  "covers",
  "covered",
  "remix",
  "remixes",
  "remixed",
  "rmx",
  "karaoke",
  "live",
  "tribute",
  "bootleg",
  "edit",
  "mashup",
  "mixed",
  "instrumental",
  "acoustic",
  "made famous",
  "in the style of",
  "originally performed",
];

// `null` when the title is unknown, because then title and artist cannot identify a recording
const recordingKey = (title: string | null, artist: string | null) => {
  const normalizedTitle = normalizeText(title ?? "");
  if (normalizedTitle === "") return null;
  return `${normalizedTitle}\n${normalizeArtist(artist ?? "")}`;
};

const containsPhrase = (text: string, phrase: string) => ` ${text} `.includes(` ${phrase} `);

const sum = (values: ReadonlyArray<number>) => values.reduce((total, value) => total + value, 0);

// Maps any sum of plays to -1..1. One recent listen gives 0.5, three give 0.75.
const saturate = (value: number) => value / (1 + Math.abs(value));

const playValue = (play: Play, now: number) => {
  const recency = 0.5 ** ((now - play.startedAt) / halfLifeMs);
  const listened = play.completed || play.playedMs >= listenMs;
  return listened ? recency : skipValue * recency;
};

const matchQuality = (query: string, summary: SourceSummary) => {
  const title = normalizeTitle(summary.title ?? "");
  const artist = normalizeText(summary.artist ?? "");
  const exactMatches = [artist, normalizeArtist(summary.artist ?? "")].flatMap((name) => [
    name,
    `${name} ${title}`,
    `${title} ${name}`,
  ]);
  if (title === query || exactMatches.includes(query)) return 1;

  // With guests, so that `daft punk` finds `Starboy (feat. Daft Punk)`
  const words = new Set(simplifyText(`${summary.title ?? ""} ${summary.artist ?? ""}`).split(" "));
  const queryWords = query.split(" ");
  const found = queryWords.filter((word) => words.has(word)).length;
  return (partialMatch * found) / queryWords.length;
};

const isOtherVersion = (query: string, summary: SourceSummary) => {
  const text = simplifyText([summary.title, summary.artist, summary.album].join(" "));
  return versionMarkers.some(
    (marker) => containsPhrase(text, marker) && !containsPhrase(query, marker),
  );
};

const scoreCandidate = (
  query: string,
  candidate: Candidate,
  hits: ReadonlyArray<PopularityHit>,
  plays: ReadonlyArray<Play>,
  now: number,
) => {
  const summary = candidate.summary;
  const key = recordingKey(summary.title, summary.artist);
  const artist = normalizeArtist(summary.artist ?? "");

  const matchingHits = hits.filter(
    (hit) =>
      (hit.isrc !== null && hit.isrc === candidate.isrc) ||
      (key !== null && recordingKey(hit.title, hit.artist) === key),
  );
  const knownPopularity = Math.max(...matchingHits.map((hit) => hit.popularity));
  const popularity =
    matchingHits.length > 0 ? knownPopularity : positionPopularity / (1 + candidate.position);

  const recordingPlays = plays.filter(
    (play) => play.sourceId === summary.id || (play.isrc !== null && play.isrc === candidate.isrc),
  );
  const artistPlays = plays.filter(
    (play) => artist !== "" && normalizeArtist(play.artist ?? "") === artist,
  );

  const parts = {
    match: matchQuality(query, summary),
    otherVersion: isOtherVersion(query, summary) ? 1 : 0,
    popularity,
    recordingPlays: saturate(sum(recordingPlays.map((play) => playValue(play, now)))),
    artistPlays: saturate(sum(artistPlays.map((play) => playValue(play, now)))),
  };

  const total =
    weights.match * parts.match +
    weights.otherVersion * parts.otherVersion +
    weights.popularity * parts.popularity +
    weights.recordingPlays * parts.recordingPlays +
    weights.artistPlays * parts.artistPlays;

  return new Score({ ...parts, total });
};

// Same ISRC, else same title and artist with durations within 2 s where both are known. A new
// release can give the same recording a new ISRC.
const sameRecording = (a: Candidate, b: Candidate) => {
  if (a.isrc !== null && a.isrc === b.isrc) return true;

  const key = recordingKey(a.summary.title, a.summary.artist);
  if (key === null || key !== recordingKey(b.summary.title, b.summary.artist)) return false;

  const durationA = a.summary.durationMs;
  const durationB = b.summary.durationMs;
  return durationA === null || durationB === null || Math.abs(durationA - durationB) <= 2000;
};

/**
 * One result per recording, best first. A group shows and plays its best source: a local file,
 * then a source that the user played, then lossless, then the provider order.
 */
export const rank = (
  query: string,
  candidates: ReadonlyArray<Candidate>,
  hits: ReadonlyArray<PopularityHit>,
  plays: ReadonlyArray<Play>,
  now: number,
) => {
  const normalizedQuery = normalizeText(query);
  const playedSourceIds = new Set(plays.map((play) => play.sourceId));

  // A candidate joins the first group whose members are all the same recording
  const groups: Array<Array<Candidate>> = [];
  for (const candidate of candidates) {
    const group = groups.find((members) =>
      members.every((member) => sameRecording(member, candidate)),
    );
    if (group === undefined) groups.push([candidate]);
    else group.push(candidate);
  }

  const results = groups.map((members) => {
    const scores = members.map((member) =>
      scoreCandidate(normalizedQuery, member, hits, plays, now),
    );
    const score = scores.reduce((best, next) => (next.total > best.total ? next : best));

    const played = (candidate: Candidate) => playedSourceIds.has(candidate.summary.id);
    const compare = (a: Candidate, b: Candidate) =>
      Number(b.local) - Number(a.local) ||
      Number(played(b)) - Number(played(a)) ||
      Number(b.lossless) - Number(a.lossless) ||
      a.position - b.position;
    const best = members.reduce((current, next) => (compare(next, current) < 0 ? next : current));

    return new RankedResult({ summary: best.summary, score });
  });

  return results.toSorted((a, b) => b.score.total - a.score.total);
};
