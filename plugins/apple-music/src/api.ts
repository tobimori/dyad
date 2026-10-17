import { ProviderSource } from "@dyad/plugin";
import { Cache, Context, Data, Effect, Exit, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

export const provider = "apple_music";

const origin = "https://music.apple.com";
export const amp = "https://amp-api.music.apple.com";
const playback = "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa";

/** `stage` and `reason` go into logs, so they never contain tokens, signed URLs or keys */
export class AppleMusicError extends Data.TaggedError("AppleMusicError")<{
  readonly stage: string;
  readonly reason: string;
}> {}

// Apple answered 401. The web client token can expire before the plugin refreshes it.
class AppleTokenRejected extends Data.TaggedError("AppleTokenRejected")<{
  readonly stage: string;
  readonly reason: string;
}> {}

/** Song of the Apple Music catalog */
export class AppleTrack extends Schema.Class<AppleTrack>("AppleTrack")({
  id: Schema.String,
  attributes: Schema.Struct({
    name: Schema.String,
    artistName: Schema.String,
    albumName: Schema.optional(Schema.String),
    durationInMillis: Schema.Finite,
    isrc: Schema.optional(Schema.String),
    // `url` is a template with `{w}` and `{h}` for the size in pixels
    artwork: Schema.optional(Schema.Struct({ url: Schema.String })),
  }),
}) {}

// Apple leaves out `songs` when nothing matches
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

// HTTP errors contain requests and response bodies, including cookies and signed asset URLs
export const sendRequest = (request: HttpClientRequest.HttpClientRequest, stage: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    return yield* client
      .execute(request)
      .pipe(Effect.mapError(() => new AppleMusicError({ stage, reason: "Request failed" })));
  });

export const readResponse = <S extends Schema.Constraint>(
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
  stage: string,
) =>
  Effect.gen(function* () {
    const status = response.status;
    if (status === 401) {
      return yield* new AppleTokenRejected({ stage, reason: "Apple rejected the token" });
    }
    // A new web client token does not help, because the subscriber's token is the problem
    if (status === 403 && response.request.url.startsWith(`${amp}/v1/me/`)) {
      return yield* new AppleMusicError({
        stage,
        reason: "Apple rejected the account token. Link the account again.",
      });
    }
    if (status === 429) {
      return yield* new AppleMusicError({ stage, reason: "Apple throttled the request" });
    }
    if (status < 200 || status >= 300) {
      return yield* new AppleMusicError({ stage, reason: `Apple answered status ${status}` });
    }

    return yield* HttpClientResponse.schemaBodyJson(schema)(response).pipe(
      Effect.mapError(() => new AppleMusicError({ stage, reason: "Unexpected response" })),
    );
  });

export const requestJson = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
  stage: string,
) =>
  Effect.flatMap(sendRequest(request, stage), (response) => readResponse(response, schema, stage));

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
  const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const homepage = yield* client.get(origin);
  const html = yield* homepage.text;

  // Apple Music's web client token is published in its main JavaScript asset
  const asset = html.match(/\/(assets\/index[~-][^/"\s]+\.js)/)?.[1];
  if (asset === undefined) {
    return yield* new AppleMusicError({ stage: "web token", reason: "Web client asset not found" });
  }

  const script = yield* client.get(new URL(asset, origin));
  const javascript = yield* script.text;
  const token = javascript.match(/"(eyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)"/)?.[1];
  if (token === undefined) {
    return yield* new AppleMusicError({ stage: "web token", reason: "Web client token not found" });
  }
  return Redacted.make(token);
}).pipe(
  Effect.catchTag("HttpClientError", () =>
    Effect.fail(new AppleMusicError({ stage: "web token", reason: "Cannot read the web client" })),
  ),
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
      return yield* new AppleMusicError({
        stage: "account",
        reason: "No active Apple Music subscription",
      });
    }

    return account.meta.subscription.storefront;
  });

// Failures are not cached, so the next request tries again
const keepSuccess = (exit: Exit.Exit<unknown, unknown>) => (Exit.isSuccess(exit) ? "6 hours" : 0);

const makeSessions = Effect.gen(function* () {
  const [bearer, invalidateBearer] = yield* Effect.cachedInvalidateWithTTL(
    getWebBearer,
    keepSuccess,
  );

  const storefronts = yield* Cache.makeWith(
    (mediaUserToken: Redacted.Redacted<string>) =>
      Effect.flatMap(bearer, (token) => getStorefront(token, mediaUserToken)),
    { capacity: 1000, timeToLive: keepSuccess },
  );

  const openSession = (mediaUserToken: Redacted.Redacted<string>) =>
    Effect.gen(function* () {
      const storefront = yield* Cache.get(storefronts, mediaUserToken);
      return new AppleSession({ bearer: yield* bearer, mediaUserToken, storefront });
    });

  /** Runs `use` once more with a new web client token when Apple rejects the cached one */
  const withSession = <A, E, R>(
    mediaUserToken: Redacted.Redacted<string>,
    use: (session: AppleSession) => Effect.Effect<A, E, R>,
  ) =>
    Effect.flatMap(openSession(mediaUserToken), use).pipe(
      Effect.catchTag("AppleTokenRejected", () =>
        invalidateBearer.pipe(Effect.andThen(openSession(mediaUserToken)), Effect.flatMap(use)),
      ),
    );

  return { withSession };
});

/**
 * Keeps the web client token and the storefront of each subscriber in memory, because they cost
 * up to three requests, which is too slow for each search and each play
 */
export class AppleSessions extends Context.Service<
  AppleSessions,
  Effect.Success<typeof makeSessions>
>()("@dyad/plugin-apple-music/AppleSessions") {}

export const appleSessionsLayer = Layer.effect(AppleSessions, makeSessions);

export const catalogSource = (song: AppleTrack) =>
  new ProviderSource({
    provider,
    externalId: song.id,
    title: song.attributes.name,
    artist: song.attributes.artistName,
    album: song.attributes.albumName ?? null,
    durationMs: song.attributes.durationInMillis,
    isrc: song.attributes.isrc ?? null,
    container: "mov",
    codec: "aac",
    lossless: false,
    encrypted: true,
    artworkUrl: song.attributes.artwork?.url.replace("{w}", "600").replace("{h}", "600") ?? null,
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
