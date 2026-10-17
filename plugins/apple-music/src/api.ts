import { Data, Effect, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const origin = "https://music.apple.com";
const amp = "https://amp-api.music.apple.com";
const playback = "https://play.itunes.apple.com/WebObjects/MZPlay.woa/wa";

/** `stage` and `reason` go into logs, so they never contain tokens, signed URLs or keys */
export class AppleMusicError extends Schema.TaggedError<AppleMusicError>()("AppleMusicError", {
  stage: Schema.String,
  reason: Schema.String,
}) {}

export class AppleTrack extends Schema.Class<AppleTrack>("AppleTrack")({
  id: Schema.String,
  attributes: Schema.Struct({
    name: Schema.String,
    artistName: Schema.String,
    albumName: Schema.optional(Schema.String),
    durationInMillis: Schema.Finite,
  }),
}) {}

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
const requestJson = <S extends Schema.Constraint>(
  request: HttpClientRequest.HttpClientRequest,
  schema: S,
  stage: string,
) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.execute(request);
    return yield* HttpClientResponse.schemaBodyJson(schema)(response);
  }).pipe(
    Effect.mapError(
      () => new AppleMusicError({ stage, reason: "Request or response validation failed" }),
    ),
  );

const authorizeClient =
  (bearer: Redacted.Redacted<string>) => (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.bearerToken(bearer),
      HttpClientRequest.setHeader("Origin", origin),
    );

const authorize = (session: AppleSession) => (request: HttpClientRequest.HttpClientRequest) =>
  request.pipe(
    authorizeClient(session.bearer),
    HttpClientRequest.setHeader(
      "Cookie",
      `media-user-token=${Redacted.value(session.mediaUserToken)}`,
    ),
  );

export const getWebBearer = Effect.gen(function* () {
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

export const openAppleSession = (mediaUserToken: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const bearer = yield* getWebBearer;
    const account = yield* requestJson(
      HttpClientRequest.get(`${amp}/v1/me/account?meta=subscription`).pipe(
        authorize(new AppleSession({ bearer, mediaUserToken, storefront: "" })),
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
    return new AppleSession({
      bearer,
      mediaUserToken,
      storefront: account.meta.subscription.storefront,
    });
  });

/** The catalog needs only the web client token, not a subscriber */
export const getCatalogTrack = (
  bearer: Redacted.Redacted<string>,
  storefront: string,
  songId: string,
) =>
  requestJson(
    HttpClientRequest.get(`${amp}/v1/catalog/${storefront}/songs/${songId}`).pipe(
      authorizeClient(bearer),
    ),
    Schema.Struct({ data: Schema.NonEmptyArray(AppleTrack) }),
    "catalog",
  ).pipe(Effect.map((response) => response.data[0]));

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
