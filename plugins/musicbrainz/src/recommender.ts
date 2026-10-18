import { AccountLinkFailed, TokenLogin } from "@dyad/domain";
import {
  LibraryError,
  ProviderError,
  Recommender,
  Suggestion,
  SuggestionShelf,
} from "@dyad/plugin";
import type { Credentials } from "@dyad/plugin";
import { HttpStatusError, getJson } from "@dyad/plugin/http";
import type { HttpRequestError } from "@dyad/plugin/http";
import { Cache, Config, Effect, Exit, Redacted, Schema } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

const login = new TokenLogin({ url: "https://listenbrainz.org/settings/", label: "user token" });

const ValidToken = Schema.Struct({
  valid: Schema.Boolean,
  user_name: Schema.optional(Schema.String),
});

const playlistExtension = "https://musicbrainz.org/doc/jspf#playlist";

const CreatedFor = Schema.Struct({
  playlists: Schema.Array(
    Schema.Struct({
      playlist: Schema.Struct({
        identifier: Schema.String,
        extension: Schema.Struct({
          [playlistExtension]: Schema.Struct({
            additional_metadata: Schema.optional(
              Schema.Struct({
                algorithm_metadata: Schema.optional(Schema.Struct({ source_patch: Schema.String })),
              }),
            ),
          }),
        }),
      }),
    }),
  ),
});

const Jspf = Schema.Struct({
  track: Schema.Array(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      creator: Schema.optional(Schema.String),
    }),
  ),
});

const Playlist = Schema.Struct({ playlist: Jspf });

const Radio = Schema.Struct({
  payload: Schema.Struct({ jspf: Schema.Struct({ playlist: Jspf }) }),
});

const Submitted = Schema.Struct({ status: Schema.Literal("ok") });

// The newest playlist of each kind, in this order. The plugin names them, because LB titles carry
// the user name and the date.
const createdFor = [
  ["daily-jams", "Daily jams"],
  ["weekly-jams", "Weekly jams"],
  ["weekly-exploration", "Weekly exploration"],
] as const;

const suggestions = (playlist: typeof Jspf.Type) =>
  playlist.track.flatMap((track) =>
    track.title === undefined || track.creator === undefined
      ? []
      : [new Suggestion({ title: track.title, artist: track.creator, source: null })],
  );

/** A ListenBrainz account with a user token: scrobbles, playlists made for the user, LB Radio */
export const listenbrainzRecommender = Effect.gen(function* () {
  const services = yield* Effect.context<HttpClient.HttpClient>();
  // A fake server in tests
  const api = yield* Config.String("DYAD_LISTENBRAINZ_URL").pipe(
    Config.withDefault("https://api.listenbrainz.org"),
    Effect.orDie,
  );

  const authorized = (credentials: Credentials, request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.setHeader(
        "Authorization",
        `Token ${Redacted.value(credentials.get("token") ?? Redacted.make(""))}`,
      ),
    );

  const statusError = (error: HttpStatusError | HttpRequestError) =>
    new ProviderError({
      reason:
        error instanceof HttpStatusError
          ? `ListenBrainz answered status ${error.status}`
          : error.reason,
    });

  // Keyed by the token, in memory only. A failure is not kept.
  const userNames = yield* Cache.makeWith(
    (token: string) =>
      getJson(
        HttpClientRequest.get(`${api}/1/validate-token`).pipe(
          HttpClientRequest.setHeader("Authorization", `Token ${token}`),
        ),
        ValidToken,
      ).pipe(
        Effect.mapError(statusError),
        Effect.flatMap((answer) =>
          answer.valid && answer.user_name !== undefined
            ? Effect.succeed(answer.user_name)
            : Effect.fail(new ProviderError({ reason: "ListenBrainz rejects the token" })),
        ),
        Effect.provide(services),
      ),
    { capacity: 100, timeToLive: (exit) => (Exit.isSuccess(exit) ? "1 day" : 0) },
  );
  const userName = (credentials: Credentials) =>
    Cache.get(userNames, Redacted.value(credentials.get("token") ?? Redacted.make("")));

  const shelves = (credentials: Credentials) =>
    Effect.gen(function* () {
      const user = yield* userName(credentials);
      const list = yield* getJson(
        authorized(
          credentials,
          HttpClientRequest.get(
            `${api}/1/user/${encodeURIComponent(user)}/playlists/createdfor`,
          ).pipe(HttpClientRequest.setUrlParam("count", "25")),
        ),
        CreatedFor,
      ).pipe(Effect.mapError(statusError));

      // The list is newest first
      const kinds = list.playlists.map(({ playlist }) => ({
        id: playlist.identifier.split("/").at(-1) ?? "",
        kind: playlist.extension[playlistExtension].additional_metadata?.algorithm_metadata
          ?.source_patch,
      }));
      return yield* Effect.forEach(createdFor, ([kind, title]) =>
        Effect.gen(function* () {
          const newest = kinds.find((playlist) => playlist.kind === kind);
          if (newest === undefined) return [];
          const playlist = yield* getJson(
            authorized(
              credentials,
              HttpClientRequest.get(`${api}/1/playlist/${encodeURIComponent(newest.id)}`),
            ),
            Playlist,
          ).pipe(Effect.mapError(statusError));
          return [
            new SuggestionShelf({ title, songs: suggestions(playlist.playlist), releases: [] }),
          ];
        }),
      ).pipe(Effect.map((found) => found.flat()));
    }).pipe(Effect.provide(services));

  // LB Radio answers 401 without a token (2026)
  const radio = (seed: { readonly artist: string }, credentials: Credentials) =>
    credentials.get("token") === undefined
      ? Effect.succeed([])
      : getJson(
          authorized(
            credentials,
            HttpClientRequest.get(`${api}/1/explore/lb-radio`).pipe(
              HttpClientRequest.setUrlParams({ prompt: `artist:(${seed.artist})`, mode: "easy" }),
            ),
          ),
          Radio,
        ).pipe(
          Effect.map((answer) => suggestions(answer.payload.jspf.playlist)),
          Effect.mapError(statusError),
          Effect.provide(services),
        );

  // ListenBrainz takes many plays in one `import` request, and one play as `single`
  const scrobble = (
    plays: ReadonlyArray<{
      readonly title: string;
      readonly artist: string;
      readonly album: string | null;
      readonly durationMs: number | null;
      readonly startedAt: number;
    }>,
    credentials: Credentials,
  ) =>
    getJson(
      authorized(
        credentials,
        HttpClientRequest.post(`${api}/1/submit-listens`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            listen_type: plays.length === 1 ? "single" : "import",
            payload: plays.map((play) => ({
              listened_at: Math.floor(play.startedAt / 1000),
              track_metadata: {
                artist_name: play.artist,
                track_name: play.title,
                // JSON leaves out the keys with `undefined`
                release_name: play.album ?? undefined,
                additional_info: {
                  duration_ms: play.durationMs ?? undefined,
                  media_player: "Dyad",
                  submission_client: "Dyad",
                },
              },
            })),
          }),
        ),
      ),
      Submitted,
    ).pipe(
      Effect.asVoid,
      Effect.mapError((error) => {
        const reason = statusError(error).reason;
        if (!(error instanceof HttpStatusError)) {
          return new LibraryError({ kind: "failed", reason, retryAfterSeconds: null });
        }
        if (error.status === 401) {
          return new LibraryError({ kind: "account", reason, retryAfterSeconds: null });
        }
        if (error.status === 429) {
          return new LibraryError({
            kind: "throttled",
            reason,
            retryAfterSeconds: error.retryAfterSeconds,
          });
        }
        return new LibraryError({ kind: "failed", reason, retryAfterSeconds: null });
      }),
      Effect.provide(services),
    );

  const link = (credentials: Credentials) =>
    Effect.gen(function* () {
      yield* Cache.invalidate(
        userNames,
        Redacted.value(credentials.get("token") ?? Redacted.make("")),
      );
      return yield* userName(credentials);
    }).pipe(Effect.mapError((error) => new AccountLinkFailed({ reason: error.reason })));

  return new Recommender({
    name: "ListenBrainz",
    priority: 10,
    account: { login, link },
    shelves,
    radio,
    scrobble,
  });
});
