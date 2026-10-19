import { catalogAssertion, identifier, job } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { and, eq, isNotNull, notExists } from "drizzle-orm";
import { Clock, Effect, Layer, Schema } from "effect";

import { decideArtists } from "./artist-matching.ts";
import { artistIdOf, mbidScheme, projectArtistRows } from "./artists.ts";
import { ArtistLinkEvidence, assertArtist, musicbrainzRef } from "./assertions.ts";
import { Jobs, RetryLater } from "./jobs.ts";
import { MusicBrainzLookups, musicbrainzLookupKey, waitForMusicBrainz } from "./matching.ts";
import { Providers } from "./providers.ts";

export const artistLinksKind = "artist.links";
const sweepKey = "sweep";
// URL relations change slowly; MusicBrainz allows 1 request per second
const refreshMs = 90 * 24 * 60 * 60 * 1000;
const sweepMs = 24 * 60 * 60 * 1000;
// After ISRC lookups, which give the MusicBrainz artists
const priority = -3;

// `mbid: null` is the daily sweep, which queues the artists without links and without a job
const LinksPayload = Schema.Struct({ mbid: Schema.NullOr(Schema.String) });

const sweep = Effect.gen(function* () {
  const db = yield* Database;
  const jobs = yield* Jobs;

  // A peer that read the links of an artist also refreshes them, so that one server asks
  const artists = yield* db
    .select({ mbid: identifier.value })
    .from(identifier)
    .where(
      and(
        eq(identifier.entityType, "artist"),
        eq(identifier.scheme, mbidScheme),
        notExists(
          db
            .select({ id: catalogAssertion.id })
            .from(catalogAssertion)
            .where(
              and(
                eq(catalogAssertion.entityType, "artist"),
                eq(catalogAssertion.entityId, identifier.entityId),
                eq(catalogAssertion.field, "links"),
              ),
            ),
        ),
      ),
    );
  const waiting = new Set(
    (yield* db.select({ key: job.key }).from(job).where(eq(job.kind, artistLinksKind))).map(
      (row) => row.key,
    ),
  );
  const missing = artists.filter((row) => !waiting.has(row.mbid));
  yield* Effect.forEach(
    missing,
    (row) => jobs.enqueue(artistLinksKind, row.mbid, { mbid: row.mbid }, { priority }),
    { discard: true },
  );
  yield* jobs.enqueue(
    artistLinksKind,
    sweepKey,
    { mbid: null },
    { priority, runAt: (yield* Clock.currentTimeMillis) + sweepMs },
  );
  if (missing.length > 0) {
    yield* Effect.logInfo("Artist links queued").pipe(
      Effect.annotateLogs({ artists: missing.length }),
    );
  }
});

/**
 * Asserts the URL relations of a MusicBrainz artist and the provider artists of the URLs, then
 * decides the merges of these provider artists. Peers receive the assertions and merges, so they
 * need no request.
 */
const readLinks = Effect.fn(function* (mbid: string) {
  const db = yield* Database;
  const jobs = yield* Jobs;
  const providers = yield* Providers;
  const lookup = (yield* MusicBrainzLookups).get(musicbrainzLookupKey);
  // The plugin failed to start; the job waits for the next start
  if (lookup === undefined) return yield* new RetryLater({ retryAfterSeconds: 60 * 60 });

  const urls = yield* lookup.artistUrls(mbid).pipe(
    Effect.catchIf(
      (error) => error.retryAfterSeconds !== null,
      (error) =>
        Effect.gen(function* () {
          const retryAfterSeconds = yield* waitForMusicBrainz(error.retryAfterSeconds ?? 0);
          return yield* new RetryLater({ retryAfterSeconds });
        }),
    ),
  );

  // Each plugin answers only for the URLs of its own site
  const found = yield* Effect.forEach(urls, (url) =>
    Effect.forEach(
      [...providers].flatMap(([provider, plugin]) =>
        plugin.artistFromUrl === undefined
          ? []
          : [{ provider, artistFromUrl: plugin.artistFromUrl }],
      ),
      ({ provider, artistFromUrl }) =>
        artistFromUrl(url).pipe(
          Effect.map((externalId) =>
            externalId === null ? [] : [new ArtistLinkEvidence({ url, provider, externalId })],
          ),
        ),
    ),
  );
  const linked = [
    ...new Map(found.flat(2).map((link) => [`${link.provider}:${link.externalId}`, link])).values(),
  ];

  yield* db.transaction(() =>
    Effect.gen(function* () {
      yield* assertArtist(
        yield* artistIdOf(mbidScheme, mbid),
        mbid,
        { links: urls.toSorted() },
        null,
      );
      yield* projectArtistRows(
        linked.map((link) => ({ scheme: link.provider, externalId: link.externalId })),
      );

      const current = yield* Effect.forEach(linked, (link) =>
        Effect.gen(function* () {
          const id = yield* artistIdOf(link.provider, link.externalId);
          yield* assertArtist(id, mbid, { mbid }, link);
          return id;
        }),
      );
      const earlier = yield* db
        .select({ id: catalogAssertion.entityId })
        .from(catalogAssertion)
        .where(
          and(
            eq(catalogAssertion.entityType, "artist"),
            eq(catalogAssertion.field, "mbid"),
            eq(catalogAssertion.origin, "plugin"),
            eq(catalogAssertion.originRef, musicbrainzRef(mbid)),
            eq(catalogAssertion.retracted, false),
            isNotNull(catalogAssertion.value),
          ),
        );
      const stale = earlier.map((row) => row.id).filter((id) => !current.includes(id));
      yield* Effect.forEach(stale, (id) => assertArtist(id, mbid, { mbid: null }, null), {
        discard: true,
      });
      yield* decideArtists([...current, ...stale]);
    }),
  );

  yield* jobs.enqueue(
    artistLinksKind,
    mbid,
    { mbid },
    { priority, runAt: (yield* Clock.currentTimeMillis) + refreshMs },
  );
  yield* Effect.logDebug("Artist links read").pipe(
    Effect.annotateLogs({ urls: urls.length, linked: linked.length }),
  );
});

/** Build it after the plugins, so that the job finds the MusicBrainz plugin */
export const artistLinksLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    yield* jobs.register(
      artistLinksKind,
      LinksPayload,
      ({ mbid }) => (mbid === null ? sweep : readLinks(mbid)),
      { homeOnly: true },
    );
    yield* jobs.enqueue(artistLinksKind, sweepKey, { mbid: null }, { priority });
  }),
);
