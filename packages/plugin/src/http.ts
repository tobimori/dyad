import { Clock, Data, Duration, Effect, Exit, Option, Ref, Schema, Semaphore } from "effect";
import type { Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { HttpClientRequest } from "effect/http";

import { ProviderError } from "./index.ts";

/** The provider answered a status outside 200 to 299. Plugins decide what the status means. */
export class HttpStatusError extends Data.TaggedError("HttpStatusError")<{
  readonly status: number;
  /** Seconds from `Retry-After`. `null` when the header is missing or is an HTTP date. */
  readonly retryAfterSeconds: number | null;
}> {}

/**
 * The request failed before a status, or the body did not match the schema. `reason` is safe to
 * log: HTTP client errors contain the URL, which can be signed or carry an API key.
 */
export class HttpRequestError extends Data.TaggedError("HttpRequestError")<{
  readonly reason: "Request failed" | "Unexpected response";
}> {}

/** Maps a failed request to `ProviderError`, with the status as `<name> answered status <status>` */
export const providerError = (name: string) => (error: HttpStatusError | HttpRequestError) =>
  new ProviderError({
    reason:
      error instanceof HttpStatusError ? `${name} answered status ${error.status}` : error.reason,
  });

const RetryAfter = Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0));

/** Sends `request` and returns a response with a status from 200 to 299 */
export const send = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new HttpRequestError({ reason: "Request failed" })));

    if (response.status >= 200 && response.status < 300) return response;

    const retryAfter = Schema.decodeUnknownOption(RetryAfter)(response.headers["retry-after"]);
    return yield* new HttpStatusError({
      status: response.status,
      retryAfterSeconds: Option.getOrNull(retryAfter),
    });
  });

/** Sends `request` with any method and decodes the JSON body with `schema` */
export const getJson = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const response = yield* send(request);

    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new HttpRequestError({ reason: "Unexpected response" })),
    );
  });

/** Sends `request` and reads the body as text, for example a web page or an HLS playlist */
export const getText = (request: HttpClientRequest.HttpClientRequest) =>
  Effect.gen(function* () {
    const response = yield* send(request);

    return yield* response.text.pipe(
      Effect.mapError(() => new HttpRequestError({ reason: "Request failed" })),
    );
  });

/**
 * One queue of requests. Each request starts at least `intervalMs` after the previous one ended.
 * Use one pacer for all requests that share a rate limit.
 */
export const makePacer = (intervalMs: number) =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    const nextStart = yield* Ref.make(0);

    const markEnd = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.set(nextStart, now + intervalMs),
    );

    return <A, E, R>(request: Effect.Effect<A, E, R>) =>
      semaphore.withPermit(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const start = yield* Ref.get(nextStart);
          yield* Effect.sleep(Math.max(0, start - now));

          return yield* Effect.ensuring(request, markEnd);
        }),
      );
  });

/**
 * A token from a provider's web client, kept in memory for `timeToLive`. When the provider
 * answers one of `rejectedStatuses`, the plugin reads a new token and runs `use` once more.
 */
export const makeScrapedToken = <E, R>(
  fetchToken: Effect.Effect<Redacted.Redacted<string>, E, R>,
  options: {
    readonly timeToLive: Duration.Input;
    readonly rejectedStatuses: ReadonlyArray<number>;
  },
) =>
  Effect.gen(function* () {
    // A failure is not cached, so the next request tries again
    const [current, invalidate] = yield* Effect.cachedInvalidateWithTTL(fetchToken, (exit) =>
      Exit.isSuccess(exit) ? options.timeToLive : Duration.zero,
    );

    return <A, E2, R2>(
      use: (token: Redacted.Redacted<string>) => Effect.Effect<A, E2 | HttpStatusError, R2>,
    ) =>
      Effect.flatMap(current, use).pipe(
        Effect.catchIf(
          (error) =>
            error instanceof HttpStatusError && options.rejectedStatuses.includes(error.status),
          () => invalidate.pipe(Effect.andThen(current), Effect.flatMap(use)),
        ),
      );
  });
