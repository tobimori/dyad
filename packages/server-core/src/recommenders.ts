import {
  credential,
  playEvent,
  providerAccount,
  providerPage,
  recording,
  source,
  sourceSegment,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { PageTrack } from "@dyad/domain";
import { Scrobble } from "@dyad/plugin";
import type { Recommender } from "@dyad/plugin";
import { and, asc, eq, exists, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Clock, Context, Effect, Layer, Option, Schema } from "effect";

import { Jobs, RetryLater } from "./jobs.ts";
import { Providers, toCredentials } from "./providers.ts";
import { nextChangeSeq } from "./sync-counter.ts";

/** Recommenders that plugins add, by ID */
export class Recommenders extends Context.Service<Recommenders, Map<string, Recommender>>()(
  "@dyad/server-core/Recommenders",
) {}

/**
 * Derived state of recommendations on this replica, in memory: the sources found for suggestions,
 * the last fetch attempt of each user's shelves, and recent radios
 */
export class RecommendationMemory extends Context.Service<
  RecommendationMemory,
  {
    readonly found: Map<string, { readonly sourceId: string | null; readonly at: number }>;
    readonly attempts: Map<string, number>;
    readonly radios: Map<
      string,
      { readonly tracks: ReadonlyArray<PageTrack>; readonly at: number }
    >;
  }
>()("@dyad/server-core/RecommendationMemory") {}

export const recommendersLayer = Layer.mergeAll(
  Layer.sync(Recommenders, () => new Map()),
  Layer.sync(RecommendationMemory, () => ({
    found: new Map(),
    attempts: new Map(),
    radios: new Map(),
  })),
);

/** The account of a provider with the ID, else of the recommender */
export const accountOf = Effect.fn("accountOf")(function* (id: string) {
  const providers = yield* Providers;
  const recommenders = yield* Recommenders;
  return providers.get(id)?.account ?? recommenders.get(id)?.account;
});

/** The linked account of the recommender, with the time of the link */
export const recommenderAccount = Effect.fn("recommenderAccount")(function* (id: string) {
  const db = yield* Database;
  const [row] = yield* db
    .select({ createdAt: providerAccount.createdAt, values: credential.values })
    .from(providerAccount)
    .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id))
    .where(eq(providerAccount.provider, id));
  return Option.fromNullishOr(row).pipe(
    Option.map((found) => ({
      linkedAt: found.createdAt,
      credentials: toCredentials(found.values),
    })),
  );
});

const scrobbleKind = "recommender.scrobble";
const ScrobblePayload = Schema.Struct({ recommender: Schema.String });

const scrobbleIntervalMs = 5 * 60 * 1000;
const scrobbleBatch = 100;
// ListenBrainz counts a listen after half the song or 4 minutes, whichever is shorter
const listenMs = 4 * 60 * 1000;

const bound = alias(recording, "bound");
const canonical = alias(recording, "canonical");

// Plays from before the link stay unsent. A DJ set would show as one long song.
const waitingPlays = Effect.fn("waitingPlays")(function* (linkedAt: number) {
  const db = yield* Database;
  const title = sql<string>`coalesce(${canonical.title}, ${source.rawTitle})`;
  const artist = sql<string>`coalesce(${canonical.artistName}, ${source.rawArtist})`;
  return yield* db
    .select({
      id: playEvent.id,
      startedAt: playEvent.startedAt,
      title,
      artist,
      album: sql<string | null>`coalesce(${canonical.album}, ${source.rawAlbum})`,
      durationMs: source.rawDurationMs,
    })
    .from(playEvent)
    .innerJoin(source, eq(source.id, playEvent.sourceId))
    .leftJoin(bound, eq(bound.id, source.recordingId))
    .leftJoin(canonical, eq(canonical.id, sql`coalesce(${bound.mergedIntoId}, ${bound.id})`))
    .where(
      and(
        eq(playEvent.scrobbled, false),
        gte(playEvent.startedAt, linkedAt),
        sql`${playEvent.playedMs} >= min(${listenMs}, coalesce(${source.rawDurationMs}, ${2 * listenMs}) / 2)`,
        isNotNull(title),
        isNotNull(artist),
        sql`not ${exists(
          db
            .select({ one: sql`1` })
            .from(sourceSegment)
            .where(eq(sourceSegment.sourceId, source.id)),
        )}`,
      ),
    )
    .orderBy(asc(playEvent.startedAt))
    .limit(scrobbleBatch);
});

const runScrobble = Effect.fn("runScrobble")(function* (payload: typeof ScrobblePayload.Type) {
  const db = yield* Database;
  const jobs = yield* Jobs;
  const recommender = (yield* Recommenders).get(payload.recommender);
  const account = yield* recommenderAccount(payload.recommender);
  // Without a next run the job ends, until a new link queues it again
  if (recommender?.scrobble === undefined || Option.isNone(account)) return;

  const plays = yield* waitingPlays(account.value.linkedAt);
  if (plays.length > 0) {
    const sent = yield* recommender
      .scrobble(
        plays.map((play) => new Scrobble(play)),
        account.value.credentials,
      )
      .pipe(
        Effect.as(true),
        Effect.catchTag("LibraryError", (error) => {
          if (error.kind === "account") {
            return Effect.logWarning("Scrobbles stop until the account is linked again").pipe(
              Effect.as(false),
            );
          }
          const retryAfterSeconds =
            error.kind === "throttled" ? (error.retryAfterSeconds ?? 900) : 300;
          return Effect.logWarning("Scrobble failed", error.reason).pipe(
            Effect.andThen(Effect.fail(new RetryLater({ retryAfterSeconds }))),
          );
        }),
        Effect.annotateLogs("recommender", payload.recommender),
      );
    if (!sent) return;

    yield* db.transaction(() =>
      Effect.gen(function* () {
        const changeSeq = yield* nextChangeSeq;
        yield* db
          .update(playEvent)
          .set({ scrobbled: true, changeSeq })
          .where(
            inArray(
              playEvent.id,
              plays.map((play) => play.id),
            ),
          );
      }),
    );
  }

  const now = yield* Clock.currentTimeMillis;
  const runAt = plays.length === scrobbleBatch ? now : now + scrobbleIntervalMs;
  yield* jobs.enqueue(scrobbleKind, payload.recommender, payload, {
    runAt,
  });
});

/** Starts the scrobbles of a linked account, if its recommender sends plays */
export const queueScrobbles = Effect.fn("queueScrobbles")(function* (id: string) {
  const jobs = yield* Jobs;
  if ((yield* Recommenders).get(id)?.scrobble === undefined) return;
  yield* jobs.enqueue(scrobbleKind, id, { recommender: id });
});

/** Stops the scrobbles and deletes the cached shelves. Run it in the unlink transaction. */
export const forgetRecommendations = Effect.fn("forgetRecommendations")(function* (id: string) {
  const db = yield* Database;
  const jobs = yield* Jobs;
  yield* jobs.cancel(scrobbleKind, id);
  yield* db
    .delete(providerPage)
    .where(
      and(
        eq(providerPage.provider, id),
        eq(providerPage.kind, "personal"),
        eq(providerPage.externalId, ""),
      ),
    );
});

/** Build it after the plugins, so that the first runs find their recommenders */
export const recommendationsLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;

    yield* jobs.register(scrobbleKind, ScrobblePayload, runScrobble);

    const accounts = yield* db
      .select({ provider: providerAccount.provider })
      .from(providerAccount)
      // Only the replica with the credential scrobbles
      .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id));
    yield* Effect.forEach(accounts, (account) => queueScrobbles(account.provider), {
      discard: true,
    });
  }).pipe(Effect.orDie),
);
