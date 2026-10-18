import { ProviderSource } from "@dyad/plugin";
import {
  getJson,
  getText,
  HttpRequestError,
  HttpStatusError,
  makeScrapedToken,
} from "@dyad/plugin/http";
import { Cache, Data, Effect, Exit, Redacted, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

export const provider = "apple_music";

const origin = "https://music.apple.com";
export const amp = "https://amp-api.music.apple.com";
const playback = "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa";

/** `stage` and `reason` go into logs, so they never contain tokens, signed URLs or keys */
export class AppleMusicError extends Data.TaggedError("AppleMusicError")<{
  readonly stage: string;
  readonly reason: string;
}> {}

/** Only a new link can help: Apple rejected the subscriber's token, or the subscription ended */
export class AppleAccountError extends Data.TaggedError("AppleAccountError")<{
  readonly stage: string;
  readonly reason: string;
}> {}

export class AppleThrottled extends Data.TaggedError("AppleThrottled")<{
  readonly stage: string;
  readonly reason: string;
  readonly retryAfterSeconds: number | null;
}> {}

/** Song of the Apple Music catalog */
export class AppleTrack extends Schema.Class<AppleTrack>("AppleTrack")({
  id: Schema.String,
  attributes: Schema.Struct({
    name: Schema.String,
    artistName: Schema.String,
    albumName: Schema.optional(Schema.String),
    // Apple leaves out both for a song that is not released yet (October 2026)
    durationInMillis: Schema.optional(Schema.Finite),
    playParams: Schema.optional(Schema.Struct({ id: Schema.String })),
    isrc: Schema.optional(Schema.String),
    // `url` is a template with `{w}` and `{h}` for the size in pixels
    artwork: Schema.optional(Schema.Struct({ url: Schema.String })),
    // Apple leaves it out for songs without a rating
    contentRating: Schema.optional(Schema.String),
  }),
}) {}

// Apple leaves out `songs` when nothing matches (October 2026)
const SearchResults = Schema.Struct({
  results: Schema.Struct({
    songs: Schema.optional(Schema.Struct({ data: Schema.Array(AppleTrack) })),
  }),
});

const Account = Schema.Struct({
  meta: Schema.Struct({
    subscription: Schema.Struct({ active: Schema.Boolean, storefront: Schema.NonEmptyString }),
  }),
});

const WebPlayback = Schema.Struct({
  songList: Schema.NonEmptyArray(
    Schema.Struct({
      assets: Schema.Array(Schema.Struct({ flavor: Schema.String, URL: Schema.String })),
    }),
  ),
});

export class AppleSession extends Data.Class<{
  readonly bearer: Redacted.Redacted<string>;
  readonly mediaUserToken: Redacted.Redacted<string>;
  readonly storefront: string;
}> {}

/**
 * Gives each Apple status its meaning. A 401 stays an `HttpStatusError`, because a new web client
 * token can help, and the session then retries once.
 */
export const appleError =
  (stage: string, request: HttpClientRequest.HttpClientRequest) =>
  (error: HttpStatusError | HttpRequestError) => {
    if (error instanceof HttpRequestError)
      return new AppleMusicError({ stage, reason: error.reason });
    if (error.status === 401) return error;

    // A new web client token does not help, because the subscriber's token is the problem
    if (error.status === 403 && request.url.startsWith(`${amp}/v1/me/`)) {
      return new AppleAccountError({
        stage,
        reason: "Apple rejected the account token. Link the account again.",
      });
    }
    if (error.status === 429) {
      return new AppleThrottled({
        stage,
        reason: "Apple throttled the request",
        retryAfterSeconds: error.retryAfterSeconds,
      });
    }

    return new AppleMusicError({ stage, reason: `Apple answered status ${error.status}` });
  };

export const requestJson = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
  stage: string,
) => getJson(request, schema).pipe(Effect.mapError(appleError(stage, request)));

const withBearer =
  (bearer: Redacted.Redacted<string>) => (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.bearerToken(bearer),
      HttpClientRequest.setHeader("Origin", origin),
    );

export const authorize =
  (user: {
    readonly bearer: Redacted.Redacted<string>;
    readonly mediaUserToken: Redacted.Redacted<string>;
  }) =>
  (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      withBearer(user.bearer),
      HttpClientRequest.setHeader(
        "Cookie",
        `media-user-token=${Redacted.value(user.mediaUserToken)}`,
      ),
    );

const getWebBearer = Effect.gen(function* () {
  const html = yield* getText(HttpClientRequest.get(origin));

  // Apple Music's web client token is in its main JavaScript asset (October 2026)
  const asset = html.match(/\/(assets\/index[~-][^/"\s]+\.js)/)?.[1];
  if (asset === undefined) {
    return yield* new AppleMusicError({ stage: "web token", reason: "Web client asset not found" });
  }

  const javascript = yield* getText(HttpClientRequest.get(new URL(asset, origin)));
  const token = javascript.match(/"(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/)?.[1];
  if (token === undefined) {
    return yield* new AppleMusicError({ stage: "web token", reason: "Web client token not found" });
  }
  return Redacted.make(token);
}).pipe(
  Effect.catchTags({
    HttpStatusError: () =>
      Effect.fail(
        new AppleMusicError({ stage: "web token", reason: "Cannot read the web client" }),
      ),
    HttpRequestError: () =>
      Effect.fail(
        new AppleMusicError({ stage: "web token", reason: "Cannot read the web client" }),
      ),
  }),
);

const getStorefront = (
  bearer: Redacted.Redacted<string>,
  mediaUserToken: Redacted.Redacted<string>,
) =>
  Effect.gen(function* () {
    const account = yield* requestJson(
      HttpClientRequest.get(`${amp}/v1/me/account?meta=subscription`).pipe(
        authorize({ bearer, mediaUserToken }),
      ),
      Account,
      "account",
    );
    if (!account.meta.subscription.active) {
      return yield* new AppleAccountError({
        stage: "account",
        reason: "No active Apple Music subscription",
      });
    }

    return account.meta.subscription.storefront;
  });

// Apple publishes a new web client token from time to time and rejects the old one later. A 401
// replaces the token at once. The time limit also replaces it before Apple rejects it.
const bearerLifetime = "6 hours";

// A subscription can end or move to another country
const storefrontLifetime = "6 hours";

class StorefrontRequest extends Data.Class<{
  readonly bearer: Redacted.Redacted<string>;
  readonly mediaUserToken: Redacted.Redacted<string>;
}> {}

/**
 * Keeps the web client token and the storefront of each subscriber in memory, because they cost
 * up to three requests, which is too slow for each search and each play.
 */
export const sessionCache = Effect.gen(function* () {
  const withWebToken = yield* makeScrapedToken(getWebBearer, {
    timeToLive: bearerLifetime,
    rejectedStatuses: [401],
  });

  const storefronts = yield* Cache.makeWith(
    (request: StorefrontRequest) => getStorefront(request.bearer, request.mediaUserToken),
    {
      capacity: 1000,
      // Failures are not cached, so the next request tries again
      timeToLive: (exit) => (Exit.isSuccess(exit) ? storefrontLifetime : 0),
    },
  );

  return <A, E, R>(
    mediaUserToken: Redacted.Redacted<string>,
    use: (session: AppleSession) => Effect.Effect<A, E | HttpStatusError, R>,
  ) =>
    withWebToken((bearer) =>
      Effect.gen(function* () {
        const storefront = yield* Cache.get(
          storefronts,
          new StorefrontRequest({ bearer, mediaUserToken }),
        );
        return yield* use(new AppleSession({ bearer, mediaUserToken, storefront }));
      }),
    ).pipe(
      Effect.catchIf(
        (error) => error instanceof HttpStatusError,
        () =>
          Effect.fail(
            new AppleMusicError({ stage: "web token", reason: "Apple rejected the token" }),
          ),
      ),
    );
});

export const catalogSource = (song: AppleTrack) =>
  new ProviderSource({
    externalId: song.id,
    title: song.attributes.name,
    artist: song.attributes.artistName,
    album: song.attributes.albumName ?? null,
    durationMs: song.attributes.durationInMillis ?? null,
    isrc: song.attributes.isrc ?? null,
    container: "mov",
    codec: "aac",
    lossless: false,
    encrypted: true,
    artworkUrl: song.attributes.artwork?.url.replace("{w}", "600").replace("{h}", "600") ?? null,
    // Songs have artist IDs only in relationships, which these requests do not include
    artists: [],
    explicit: song.attributes.contentRating === "explicit",
  });

/** The catalog needs only the web client token, not a subscriber */
export const searchCatalog = (
  bearer: Redacted.Redacted<string>,
  storefront: string,
  term: string,
) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${amp}/v1/catalog/${storefront}/search`).pipe(
      HttpClientRequest.setUrlParams({ term, types: "songs", limit: 25 }),
      withBearer(bearer),
    );
    const response = yield* requestJson(request, SearchResults, "search");
    const songs = response.results.songs?.data ?? [];

    return songs.map(catalogSource);
  });

/** URL of the HLS media playlist of the 256 kbps AAC web asset */
export const resolveAacAsset = (session: AppleSession, songId: string) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(`${playback}/webPlayback`).pipe(
      authorize(session),
      HttpClientRequest.bodyJson({ salableAdamId: songId, language: "en-US" }),
    );
    const response = yield* requestJson(request, WebPlayback, "playback asset");

    // Flavor 28 is the 256 kbps AAC asset with AES-CTR (`cenc`) encryption, which Widevine keys
    // decrypt
    const asset = response.songList[0].assets.find((item) => item.flavor === "28:ctrp256");
    if (asset === undefined) {
      return yield* new AppleMusicError({
        stage: "playback asset",
        reason: "AAC web asset is unavailable",
      });
    }
    return asset.URL;
  }).pipe(
    Effect.catchTag("HttpBodyError", () =>
      Effect.fail(
        new AppleMusicError({ stage: "playback asset", reason: "Cannot encode the request" }),
      ),
    ),
  );

export const exchangeLicense = (
  session: AppleSession,
  songId: string,
  uri: string,
  challenge: Uint8Array,
) =>
  Effect.gen(function* () {
    const request = yield* HttpClientRequest.post(`${playback}/acquireWebPlaybackLicense`).pipe(
      authorize(session),
      HttpClientRequest.bodyJson({
        challenge: Buffer.from(challenge).toString("base64"),
        "key-system": "com.widevine.alpha",
        uri,
        adamId: songId,
        isLibrary: false,
        "user-initiated": true,
      }),
    );
    const response = yield* requestJson(
      request,
      Schema.Struct({ status: Schema.Literal(0), license: Schema.Uint8ArrayFromBase64 }),
      "license",
    );
    return response.license;
  }).pipe(
    Effect.catchTag("HttpBodyError", () =>
      Effect.fail(new AppleMusicError({ stage: "license", reason: "Cannot encode the request" })),
    ),
  );
