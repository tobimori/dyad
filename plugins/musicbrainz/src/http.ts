import { getJson, makePacer } from "@dyad/plugin/http";
import { Context, Data, Effect, Layer } from "effect";
import type { Schema } from "effect";
import { HttpClientRequest } from "effect/http";

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

// MusicBrainz allows 1 request per second per IP on average. The ListenBrainz labs API has no
// published limit.
const makePacing = Effect.gen(function* () {
  const musicbrainz = yield* makePacer(1100);
  const listenbrainz = yield* makePacer(1000);
  return { musicbrainz, listenbrainz };
});

/**
 * One request queue per service, shared by all lookups of the plugin, because the limits are per
 * IP. A queue runs the request of the caller, so it needs what the request needs.
 *
 * @effect-expect-leaking R
 */
export class Pacing extends Context.Service<Pacing, Effect.Success<typeof makePacing>>()(
  "@dyad/plugin-musicbrainz/Pacing",
) {}

export const pacingLayer = Layer.effect(Pacing, makePacing);

/**
 * Sends one request at a time per service. Use the plugin `HttpClient`, which times out, because a
 * request that hangs holds the queue of its service.
 */
export const requestJson = <S extends Schema.Constraint>(
  service: Service,
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
) =>
  Effect.gen(function* () {
    const pace = (yield* Pacing)[service];

    return yield* pace(
      getJson(request.pipe(HttpClientRequest.setHeader("User-Agent", userAgent)), schema),
    ).pipe(
      Effect.catchTags({
        HttpStatusError: (error) => {
          if (error.status === 429 || error.status === 503) {
            return Effect.fail(
              new RateLimited({ service, retryAfterSeconds: error.retryAfterSeconds }),
            );
          }
          return Effect.fail(
            new LookupError({ service, reason: `Answered status ${error.status}` }),
          );
        },
        HttpRequestError: (error) =>
          Effect.fail(new LookupError({ service, reason: error.reason })),
      }),
    );
  });
