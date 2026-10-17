import { Clock, Context, Data, Effect, Layer, Option, Ref, Schema, Semaphore } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

// MusicBrainz blocks clients without an application name, a version and a contact URL
const userAgent = "Dyad/0.0.0 ( https://github.com/tobimori/dyad )";

// `listenbrainz` is the labs API at `labs.api.listenbrainz.org`
type Service = "musicbrainz" | "listenbrainz";

export class LookupError extends Data.TaggedError("LookupError")<{
  readonly service: Service;
  readonly reason: string;
}> {}

/**
 * The service answered 429 or 503. The plugin does not retry, so the caller waits at least
 * `retryAfterSeconds` before the next lookup on this service. MusicBrainz sends 0 when the whole
 * server is busy (October 2026), so the caller also needs its own minimum backoff.
 */
export class RateLimited extends Data.TaggedError("RateLimited")<{
  readonly service: Service;
  readonly retryAfterSeconds: number | null;
}> {}

// `Retry-After` can also be an HTTP date. A date gives `null`.
const RetryAfter = Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0));

// MusicBrainz allows 1 request per second per IP on average. The ListenBrainz labs API has no
// published limit.
const intervalMs = { musicbrainz: 1100, listenbrainz: 1000 };

const makeQueue = Effect.gen(function* () {
  const semaphore = yield* Semaphore.make(1);
  const nextStart = yield* Ref.make(0);
  return { semaphore, nextStart };
});

const makePacing = Effect.gen(function* () {
  const musicbrainz = yield* makeQueue;
  const listenbrainz = yield* makeQueue;
  return { musicbrainz, listenbrainz };
});

/** One request queue per service, shared by all lookups of the plugin, because the limits are per IP */
export class Pacing extends Context.Service<Pacing, Effect.Success<typeof makePacing>>()(
  "@dyad/plugin-musicbrainz/Pacing",
) {}

export const pacingLayer = Layer.effect(Pacing, makePacing);

// Sends one request at a time per service and starts it `intervalMs` after the previous one ended
export const requestJson = <S extends Schema.Constraint>(
  service: Service,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const queue = (yield* Pacing)[service];
    const httpClient = yield* HttpClient.HttpClient;

    const send = Effect.gen(function* () {
      const response = yield* httpClient
        .execute(request.pipe(HttpClientRequest.setHeader("User-Agent", userAgent)))
        .pipe(Effect.mapError(() => new LookupError({ service, reason: "Request failed" })));

      const status = response.status;
      if (status === 429 || status === 503) {
        const retryAfter = Schema.decodeUnknownOption(RetryAfter)(response.headers["retry-after"]);
        return yield* new RateLimited({ service, retryAfterSeconds: Option.getOrNull(retryAfter) });
      }
      if (status < 200 || status >= 300) {
        return yield* new LookupError({ service, reason: `Answered status ${status}` });
      }

      return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError(() => new LookupError({ service, reason: "Unexpected response" })),
      );
    }).pipe(
      // A request that hangs holds the queue of its service, and Node's own timeout is about 300 s
      Effect.timeoutOrElse({
        duration: "30 seconds",
        orElse: () => Effect.fail(new LookupError({ service, reason: "Timed out" })),
      }),
    );

    const markEnd = Effect.flatMap(Clock.currentTimeMillis, (now) =>
      Ref.set(queue.nextStart, now + intervalMs[service]),
    );

    return yield* queue.semaphore.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const start = yield* Ref.get(queue.nextStart);
        yield* Effect.sleep(Math.max(0, start - now));

        return yield* Effect.ensuring(send, markEnd);
      }),
    );
  });
