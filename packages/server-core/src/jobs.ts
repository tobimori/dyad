import { job } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { and, asc, desc, eq, inArray, lte, min, sql } from "drizzle-orm";
import {
  Cause,
  Clock,
  Context,
  Data,
  Duration,
  Effect,
  Exit,
  Latch,
  Layer,
  Option,
  Schema,
} from "effect";

import { HomeServer } from "./home-server.ts";

/** Ends a job run as failed and sets the next run, for example from a provider's `Retry-After` */
export class RetryLater extends Data.TaggedError("RetryLater")<{
  readonly retryAfterSeconds: number;
}> {}

// A failed run as the worker records it. `tag` is only the error tag, because error fields can
// hold URLs or provider responses. `Data.TaggedError` sets the name to the tag.
class JobFailure extends Data.TaggedError("JobFailure")<{
  readonly tag: string;
  readonly retryAfterSeconds: number | undefined;
}> {}

// Other failures wait 30 seconds, doubled for each earlier failure
const backoffBaseMs = 30 * 1000;
const backoffLimitMs = 6 * 60 * 60 * 1000;

const toJobFailure = (error: Error) =>
  new JobFailure({
    tag: error.name,
    retryAfterSeconds: error instanceof RetryLater ? error.retryAfterSeconds : undefined,
  });

const makeJobs = Effect.gen(function* () {
  const db = yield* Database;
  const device = Option.isSome(yield* HomeServer);
  const handlers = new Map<string, (payload: Schema.Json) => Effect.Effect<void, JobFailure>>();
  // Each enqueue and registration opens it, so that a sleeping worker reads the table again
  const wake = yield* Latch.make();

  /**
   * Adds a job, or updates the waiting job with the same `kind` and `key`. The job keeps the
   * earlier run time, unless `replace` is set. `runAt` is in epoch milliseconds and defaults to
   * now. A higher `priority` runs first among due jobs.
   */
  const enqueue = Effect.fn("enqueue")(function* (
    kind: string,
    key: string,
    payload: Schema.Json,
    options: {
      readonly priority?: number;
      readonly runAt?: number;
      readonly replace?: boolean;
    } = {},
  ) {
    const now = yield* Clock.currentTimeMillis;
    const runAt = options.runAt ?? now;
    const priority = options.priority ?? 0;

    // During a run, the row still has the time of that run, and the request is for one more run
    const nextRunAt =
      options.replace === true
        ? runAt
        : sql`CASE WHEN ${job.startedAt} IS NULL THEN min(${job.nextRunAt}, ${runAt}) ELSE ${runAt} END`;

    yield* db
      .insert(job)
      .values({
        kind,
        key,
        payload,
        priority,
        nextRunAt: runAt,
        attempts: 0,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [job.kind, job.key],
        set: { payload, priority, nextRunAt, startedAt: null, updatedAt: now },
      });

    yield* wake.open;
  });

  /** Removes the job. A run in progress continues, but its end does not schedule it again. */
  const cancel = (kind: string, key: string) =>
    db
      .delete(job)
      .where(and(eq(job.kind, kind), eq(job.key, key)))
      .pipe(Effect.asVoid);

  /**
   * Runs the jobs of `kind` with `handler`. A payload that does not decode fails the run. Jobs of
   * kinds without a handler wait. A device leaves `homeOnly` jobs to its home server.
   */
  const register = Effect.fn("register")(function* <A, E extends Error, R>(
    kind: string,
    payload: Schema.Decoder<A>,
    handler: (payload: A) => Effect.Effect<void, E, R>,
    options: { readonly homeOnly?: true } = {},
  ) {
    if (device && options.homeOnly === true) return;
    if (handlers.has(kind)) {
      return yield* Effect.die(new Error(`Job kind "${kind}" is already registered`));
    }

    const services = yield* Effect.context<R>();
    handlers.set(kind, (stored) =>
      Schema.decodeEffect(payload)(stored).pipe(
        Effect.mapError(
          () => new JobFailure({ tag: "InvalidPayload", retryAfterSeconds: undefined }),
        ),
        Effect.flatMap((value) => handler(value).pipe(Effect.mapError(toJobFailure))),
        Effect.provideContext(services),
      ),
    );

    yield* wake.open;
  });

  const run = Effect.fn("run")(function* (row: typeof job.$inferSelect, startedAt: number) {
    const handler = handlers.get(row.kind);
    if (handler === undefined) return;

    const exit = yield* Effect.exit(handler(row.payload));
    const sameJob = and(eq(job.kind, row.kind), eq(job.key, row.key));
    // If the handler or another caller enqueued the job during the run, that request stays
    const sameRun = and(sameJob, eq(job.startedAt, startedAt));

    if (Exit.isSuccess(exit)) {
      yield* db.update(job).set({ attempts: 0, lastError: null }).where(sameJob);
      yield* db.delete(job).where(sameRun);
      return;
    }

    const now = yield* Clock.currentTimeMillis;
    const failure = Cause.findErrorOption(exit.cause);
    const lastError = Option.match(failure, { onNone: () => "Defect", onSome: (f) => f.tag });
    const retryAfterSeconds = Option.getOrUndefined(failure)?.retryAfterSeconds;
    const delayMs =
      retryAfterSeconds === undefined
        ? Math.min(backoffBaseMs * 2 ** row.attempts, backoffLimitMs)
        : retryAfterSeconds * 1000;

    yield* db
      .update(job)
      .set({
        nextRunAt: now + delayMs,
        attempts: row.attempts + 1,
        lastError,
        startedAt: null,
        updatedAt: now,
      })
      .where(sameRun);

    const log = Option.isNone(failure)
      ? Effect.logError("Job crashed", exit.cause)
      : Effect.logWarning("Job failed");
    yield* log.pipe(
      Effect.annotateLogs({ kind: row.kind, key: row.key, error: lastError, retryInMs: delayMs }),
    );
  });

  const runNext = Effect.gen(function* () {
    yield* wake.close;
    const now = yield* Clock.currentTimeMillis;
    const kinds = [...handlers.keys()];

    // A row that still has `started_at` from before a restart is due again, so it runs again
    const next = yield* db.transaction((tx) =>
      Effect.gen(function* () {
        const [row] = yield* tx
          .select()
          .from(job)
          .where(and(inArray(job.kind, kinds), lte(job.nextRunAt, now)))
          .orderBy(desc(job.priority), asc(job.nextRunAt))
          .limit(1);
        if (row === undefined) return undefined;

        yield* tx
          .update(job)
          .set({ startedAt: now })
          .where(and(eq(job.kind, row.kind), eq(job.key, row.key)));
        return row;
      }),
    );

    if (next !== undefined) return yield* run(next, now);

    const [earliest] = yield* db
      .select({ runAt: min(job.nextRunAt) })
      .from(job)
      .where(inArray(job.kind, kinds));
    const runAt = earliest?.runAt ?? null;
    const sleep = runAt === null ? Effect.never : Effect.sleep(Duration.millis(runAt - now));
    yield* Effect.race(wake.await, sleep);
  });

  // A database error must not end the worker. The pause keeps a lasting error from filling the log.
  yield* runNext.pipe(
    Effect.catchCause((cause) =>
      Effect.logError("Job worker failed", cause).pipe(Effect.andThen(Effect.sleep("1 minute"))),
    ),
    Effect.forever,
    Effect.forkScoped,
  );

  return { enqueue, cancel, register };
});

/** The background job queue of this replica. Jobs persist and run one at a time. */
export class Jobs extends Context.Service<Jobs, Effect.Success<typeof makeJobs>>()(
  "@dyad/server-core/Jobs",
) {}

export const jobsLayer = Layer.effect(Jobs, makeJobs);
