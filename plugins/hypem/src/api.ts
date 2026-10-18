import {
  ProviderError,
  ProviderLink,
  ProviderShelf,
  ProviderSource,
  ProviderTrack,
} from "@dyad/plugin";
import { getJson, getText, HttpStatusError } from "@dyad/plugin/http";
import type { HttpRequestError, makePacer } from "@dyad/plugin/http";
import { Effect, Option, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

export const provider = "hypem";

// The v2 API of the Hype Machine apps, without a key
const api = "https://api.hypem.com/v2";
const webUrl = "https://hypem.com";

const shelfSize = 20;

class Item extends Schema.Class<Item>("Item")({
  itemid: Schema.String,
  artist: Schema.String,
  title: Schema.String,
  /** Seconds */
  time: Schema.Finite,
  thumb_url_large: Schema.String,
}) {}

// The outbound links of Hype Machine, in order of preference. The formats are the ones that the
// Bandcamp and SoundCloud plugins resolve.
const links = {
  bc: {
    provider: "bandcamp",
    name: "Bandcamp",
    page: /^https:\/\/[\w-]+\.bandcamp\.com\/track\//,
    container: "mp3",
    codec: "mp3",
    bitrate: 128_000,
  },
  sc: {
    provider: "soundcloud",
    name: "SoundCloud",
    page: /^https:\/\/soundcloud\.com\/(?!not\/found)/,
    container: "mov",
    codec: "aac",
    bitrate: null,
  },
} as const;

const ExternalId = Schema.TemplateLiteralParser([
  Schema.Literals(["bc", "sc"]),
  "-",
  Schema.String,
]);

// Attribute values of the Bandcamp track page, JSON with `&quot;` for quotes
const BandcampBand = Schema.fromJsonString(Schema.Struct({ id: Schema.Int }));
const BandcampItem = Schema.fromJsonString(
  Schema.Struct({ item_type: Schema.Literal("t"), item_id: Schema.Int }),
);

const toProviderError = (error: HttpStatusError | HttpRequestError) =>
  new ProviderError({
    reason:
      error instanceof HttpStatusError
        ? `Hype Machine answered status ${error.status}`
        : error.reason,
  });

// `/go/<kind>/<item>` answers 302 with the track page, or with `/not/found` when it has none
const linkedPage = (kind: keyof typeof links, itemId: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.get(`${webUrl}/go/${kind}/${itemId}`).pipe(
      // The core's client uses `fetch`, which follows redirects unless told otherwise
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.mapError(() => new ProviderError({ reason: "Cannot reach Hype Machine" })),
    );
    if (response.status !== 302) {
      return yield* new ProviderError({
        reason: `Hype Machine answered status ${response.status}`,
      });
    }
    const location = response.headers["location"];
    return location !== undefined && links[kind].page.test(location)
      ? Option.some(location)
      : Option.none();
  });

const firstLink = (itemId: string) =>
  Effect.gen(function* () {
    for (const kind of ["bc", "sc"] as const) {
      if (Option.isSome(yield* linkedPage(kind, itemId))) return Option.some(kind);
    }
    return Option.none();
  });

const readShelf = (
  pace: Effect.Success<ReturnType<typeof makePacer>>,
  title: string,
  request: HttpClientRequest.HttpClientRequest,
) =>
  Effect.gen(function* () {
    const items = yield* getJson(request, Schema.Array(Item)).pipe(
      Effect.mapError(toProviderError),
    );

    // Items without a link that a provider plays are left out
    const tracks = yield* Effect.forEach(items, (item) =>
      Effect.gen(function* () {
        const kind = Option.getOrNull(yield* pace(firstLink(item.itemid)));
        // Hype Machine gives 30 seconds for a SoundCloud track that plays only as a snippet
        if (kind === null || (kind === "sc" && item.time <= 30)) return [];

        const link = links[kind];
        const source = new ProviderSource({
          externalId: `${kind}-${item.itemid}`,
          title: item.title,
          artist: item.artist === "" ? null : item.artist,
          album: null,
          durationMs: item.time > 0 ? item.time * 1000 : null,
          isrc: null,
          container: link.container,
          codec: link.codec,
          lossless: false,
          encrypted: false,
          artworkUrl: item.thumb_url_large,
          artists: [],
          explicit: null,
          bitrate: link.bitrate,
          uploader: null,
          albumId: null,
        });
        return [new ProviderTrack({ disc: null, number: null, source, streamable: true })];
      }),
    );
    return new ProviderShelf({ title, tracks: tracks.flat(), releases: [] });
  });

/** Popular and Latest, with the tracks that Bandcamp or SoundCloud plays */
export const readHome = (pace: Effect.Success<ReturnType<typeof makePacer>>) =>
  Effect.gen(function* () {
    const popular = yield* readShelf(
      pace,
      "Popular",
      HttpClientRequest.get(`${api}/popular`).pipe(
        HttpClientRequest.setUrlParams({ mode: "now", count: shelfSize }),
      ),
    );
    const latest = yield* readShelf(
      pace,
      "Latest",
      HttpClientRequest.get(`${api}/tracks`).pipe(
        HttpClientRequest.setUrlParams({ sort: "latest", count: shelfSize }),
      ),
    );
    return [popular, latest];
  });

/** Links to the Bandcamp or SoundCloud source of an item */
export const resolveItem = (externalId: string) =>
  Effect.gen(function* () {
    const [kind, , itemId] = yield* Schema.decodeUnknownEffect(ExternalId)(externalId).pipe(
      Effect.mapError(() => new ProviderError({ reason: "Invalid item ID" })),
    );
    const link = links[kind];

    const page = yield* linkedPage(kind, itemId);
    if (Option.isNone(page)) {
      return yield* new ProviderError({ reason: `Hype Machine has no ${link.name} link anymore` });
    }
    const html = yield* getText(HttpClientRequest.get(page.value)).pipe(
      Effect.mapError(() => new ProviderError({ reason: `Cannot read the ${link.name} page` })),
    );
    const unknownPage = new ProviderError({ reason: `Unexpected ${link.name} page` });

    if (kind === "sc") {
      const trackId = html.match(/soundcloud:\/\/sounds:(\d+)/)?.[1];
      if (trackId === undefined) return yield* unknownPage;
      return new ProviderLink({ provider: link.provider, externalId: trackId });
    }

    const attribute = (pattern: RegExp) => html.match(pattern)?.[1]?.replaceAll("&quot;", '"');
    const band = yield* Schema.decodeUnknownEffect(BandcampBand)(
      attribute(/data-band="([^"]*)"/),
    ).pipe(Effect.mapError(() => unknownPage));
    const item = yield* Schema.decodeUnknownEffect(BandcampItem)(
      attribute(/name="bc-page-properties" content="([^"]*)"/),
    ).pipe(Effect.mapError(() => unknownPage));
    return new ProviderLink({ provider: link.provider, externalId: `${band.id}-${item.item_id}` });
  });
