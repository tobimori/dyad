import { playEvent, recording, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { PageTrack } from "@dyad/domain";
import type { SourceSummary, UserId } from "@dyad/domain";
import { and, eq, gte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Clock, Data, Effect } from "effect";

import { normalizeArtist, normalizeTitle } from "./normalize.ts";
import { playHistoryMs, playValue, saturate } from "./ranking.ts";

/** One key for the versions of a song: the title without version parts, and the first artist */
export const songKey = (title: string | null, artist: string | null) =>
  `${normalizeTitle(title ?? "")}\n${normalizeArtist(artist ?? "")}`;

const recentMs = 14 * 24 * 60 * 60 * 1000;

// Tune the suggestions here
const artistWeight = 0.8;
const perArtist = 2;
// An affinity above it explains a suggestion with the artist
const explainedAffinity = 0.3;

class ArtistTaste extends Data.Class<{
  /** From -1 to 1: decayed plays of the artist, less skips */
  readonly affinity: number;
  /** As the user's sources show it */
  readonly name: string;
}> {}

/** What the user's plays say about suggestions */
export class Taste extends Data.Class<{
  /** By `normalizeArtist` */
  readonly artists: ReadonlyMap<string, ArtistTaste>;
  /** Song keys and source IDs of the last 14 days */
  readonly recent: ReadonlySet<string>;
}> {}

const bound = alias(recording, "bound");
const canonical = alias(recording, "canonical");

export const loadTaste = (userId: UserId) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const now = yield* Clock.currentTimeMillis;
    const plays = yield* db
      .select({
        sourceId: playEvent.sourceId,
        startedAt: playEvent.startedAt,
        playedMs: playEvent.playedMs,
        completed: playEvent.completed,
        title: sql<string | null>`coalesce(${canonical.title}, ${source.rawTitle})`,
        artist: sql<string | null>`coalesce(${canonical.artistName}, ${source.rawArtist})`,
      })
      .from(playEvent)
      .innerJoin(source, eq(source.id, playEvent.sourceId))
      .leftJoin(bound, eq(bound.id, source.recordingId))
      .leftJoin(canonical, eq(canonical.id, sql`coalesce(${bound.mergedIntoId}, ${bound.id})`))
      .where(and(eq(playEvent.userId, userId), gte(playEvent.startedAt, now - playHistoryMs)));

    const sums = new Map<string, { value: number; name: string }>();
    const recent = new Set<string>();
    for (const play of plays) {
      if (play.artist !== null) {
        const key = normalizeArtist(play.artist);
        const sum = sums.get(key) ?? { value: 0, name: play.artist };
        sums.set(key, { value: sum.value + playValue(play, now), name: sum.name });
      }
      if (now - play.startedAt < recentMs) {
        recent.add(play.sourceId);
        recent.add(songKey(play.title, play.artist));
      }
    }

    return new Taste({
      artists: new Map(
        [...sums].map(([key, sum]) => [
          key,
          new ArtistTaste({ affinity: saturate(sum.value), name: sum.name }),
        ]),
      ),
      recent,
    });
  });

/** A playable suggestion before the taste applies */
export class Pick extends Data.Class<{
  readonly summary: SourceSummary;
  /** From the recommender's priority and order */
  readonly score: number;
  readonly reason: string;
}> {}

/**
 * Best first by score and artist affinity, at most 2 per artist, without recent songs, `exclude`
 * (song keys and source IDs) and repeats. With `explainArtist`, a liked artist gives the reason.
 */
export const choose = (
  taste: Taste,
  picks: ReadonlyArray<Pick>,
  options: {
    readonly exclude: ReadonlySet<string>;
    readonly limit: number;
    readonly explainArtist: boolean;
  },
) => {
  const scored = picks
    .map((pick) => {
      const artistKey = normalizeArtist(pick.summary.artist ?? "");
      const artist = taste.artists.get(artistKey);
      return {
        pick,
        artistKey,
        artist,
        total: pick.score + artistWeight * (artist?.affinity ?? 0),
      };
    })
    .toSorted((a, b) => b.total - a.total);

  const seen = new Set(options.exclude);
  const artistCounts = new Map<string, number>();
  const chosen: Array<PageTrack> = [];
  for (const { pick, artistKey, artist } of scored) {
    if (chosen.length === options.limit) break;
    const key = songKey(pick.summary.title, pick.summary.artist);
    const ids = [key, pick.summary.id];
    if (ids.some((id) => seen.has(id) || taste.recent.has(id))) continue;
    const count = artistCounts.get(artistKey) ?? 0;
    if (count === perArtist) continue;

    for (const id of ids) seen.add(id);
    artistCounts.set(artistKey, count + 1);
    const liked = artist !== undefined && artist.affinity > explainedAffinity;
    chosen.push(
      new PageTrack({
        source: pick.summary,
        disc: null,
        number: null,
        playable: true,
        reason: options.explainArtist && liked ? `Because you played ${artist.name}` : pick.reason,
      }),
    );
  }
  return chosen;
};
