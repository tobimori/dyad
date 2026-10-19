import { CreditedArtist, ProviderAudio, ProviderError, ProviderSource } from "@dyad/plugin";
import { getJson, getText, providerError, send } from "@dyad/plugin/http";
import { Cache, Data, Effect, Exit, Schema, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

export const provider = "bandcamp";

// Public endpoints of the Bandcamp web search and the Bandcamp mobile app, without an account
const searchUrl = "https://bandcamp.com/api/bcsearch_public_api/1/autocomplete_elastic";
export const detailsUrl = "https://bandcamp.com/api/mobile/25/tralbum_details";

class SearchTrack extends Schema.Class<SearchTrack>("SearchTrack")({
  id: Schema.Int,
  name: Schema.String,
  // The account. On a label account, `band_name` is the artist of the release and not its name.
  band_id: Schema.Int,
  band_name: Schema.String,
  album_name: Schema.NullOr(Schema.String),
  album_id: Schema.optional(Schema.NullOr(Schema.Int)),
  art_id: Schema.optional(Schema.NullOr(Schema.Int)),
}) {}

const SearchResults = Schema.Struct({
  auto: Schema.Struct({ results: Schema.Array(SearchTrack) }),
});

class DetailsTrack extends Schema.Class<DetailsTrack>("DetailsTrack")({
  track_id: Schema.Int,
  is_streamable: Schema.Boolean,
  /** Seconds */
  duration: Schema.optional(Schema.NullOr(Schema.Finite)),
  streaming_url: Schema.optional(
    Schema.NullOr(Schema.Struct({ "mp3-128": Schema.optional(Schema.String) })),
  ),
}) {}

class ReleaseDetails extends Schema.Class<ReleaseDetails>("ReleaseDetails")({
  // The account, not the artist
  band: Schema.optional(Schema.Struct({ name: Schema.String })),
  tracks: Schema.Array(DetailsTrack),
}) {}

// Bandcamp answers status 200 with an error object, for example for a deleted track
const Details = Schema.Union([
  ReleaseDetails,
  Schema.Struct({ error: Schema.Literal(true), error_message: Schema.String }),
]);

// The mobile app sends the band ID with each track ID
const ExternalId = Schema.TemplateLiteralParser([Schema.Int, "-", Schema.Int]);

// The core gives a provider search 8 seconds in total
const durationTimeout = "4 seconds";

class Release extends Data.Class<{ bandId: number; type: "a" | "t"; id: number }> {}

const fetchDetails = Effect.fnUntraced(function* ({ bandId, type, id }: Release) {
  const request = HttpClientRequest.get(detailsUrl).pipe(
    HttpClientRequest.setUrlParams({ band_id: bandId, tralbum_type: type, tralbum_id: id }),
  );
  const details = yield* getJson(request, Details).pipe(Effect.mapError(providerError("Bandcamp")));
  if ("error" in details) {
    return yield* new ProviderError({ reason: `Bandcamp: ${details.error_message}` });
  }
  return details;
});

/** Each pause while the user types starts a new search, which reads the same releases again */
export const detailsCache = Cache.makeWith(fetchDetails, {
  capacity: 1000,
  timeToLive: (exit) => (Exit.isSuccess(exit) ? "10 minutes" : 0),
});

export const searchTracks = Effect.fn("searchTracks")(function* (
  details: Cache.Cache<Release, ReleaseDetails, ProviderError>,
  query: string,
) {
  const request = HttpClientRequest.post(searchUrl).pipe(
    HttpClientRequest.bodyJsonUnsafe({
      search_text: query,
      search_filter: "t",
      full_page: false,
      fan_id: null,
    }),
  );
  const response = yield* getJson(request, SearchResults).pipe(
    Effect.mapError(providerError("Bandcamp")),
  );

  // One request per release gives the durations of all its tracks and the account name. A single
  // has no album.
  const releases = new Map(
    response.auto.results.map((track) => {
      const release =
        track.album_id === undefined || track.album_id === null
          ? new Release({ bandId: track.band_id, type: "t", id: track.id })
          : new Release({ bandId: track.band_id, type: "a", id: track.album_id });
      return [`${release.bandId}-${release.type}-${release.id}`, release];
    }),
  );
  // A timeout keeps the details that arrived
  const durations = new Map<number, number>();
  const accounts = new Map<number, CreditedArtist>();
  yield* Effect.forEach(
    releases.values(),
    (release) =>
      Cache.get(details, release).pipe(
        Effect.tap(({ band, tracks }) =>
          Effect.sync(() => {
            if (band !== undefined) {
              accounts.set(
                release.bandId,
                new CreditedArtist({ id: String(release.bandId), name: band.name }),
              );
            }
            for (const track of tracks) {
              if (track.duration !== undefined && track.duration !== null) {
                durations.set(track.track_id, Math.round(track.duration * 1000));
              }
            }
          }),
        ),
        Effect.ignore,
      ),
    { concurrency: 4, discard: true },
  ).pipe(Effect.timeout(durationTimeout), Effect.ignore);

  return response.auto.results.map(
    (track) =>
      new ProviderSource({
        externalId: `${track.band_id}-${track.id}`,
        title: track.name,
        artist: track.band_name,
        album: track.album_name,
        durationMs: durations.get(track.id) ?? null,
        isrc: null,
        container: "mp3",
        codec: "mp3",
        lossless: false,
        encrypted: false,
        // Image format `_10` is the full-size JPEG of the release art
        artworkUrl:
          track.art_id === undefined || track.art_id === null
            ? null
            : `https://f4.bcbits.com/img/a${track.art_id}_10.jpg`,
        artists: [],
        explicit: null,
        bitrate: 128_000,
        uploader: accounts.get(track.band_id) ?? null,
        albumId:
          track.album_id === undefined || track.album_id === null
            ? `t-${track.band_id}-${track.id}`
            : `a-${track.band_id}-${track.album_id}`,
      }),
  );
});

/** Streams the public 128 kbps MP3 of a track */
export const resolveTrack = Effect.fn("resolveTrack")(function* (externalId: string) {
  const [bandId, , trackId] = yield* Schema.decodeUnknownEffect(ExternalId)(externalId).pipe(
    Effect.mapError(() => new ProviderError({ reason: "Invalid track ID" })),
  );

  const { tracks } = yield* fetchDetails(new Release({ bandId, type: "t", id: trackId }));
  const track = tracks.find((item) => item.track_id === trackId);
  if (track === undefined) {
    return yield* new ProviderError({ reason: "Bandcamp did not return the track" });
  }

  const streamUrl = track.streaming_url?.["mp3-128"];
  if (!track.is_streamable || streamUrl === undefined) {
    return yield* new ProviderError({
      reason: "The artist does not allow streams of this track",
    });
  }

  // Open the stream here, so that a failure occurs before the core starts its response
  const response = yield* send(HttpClientRequest.get(streamUrl)).pipe(
    Effect.mapError(providerError("Bandcamp")),
  );

  // Errors contain the signed stream URL
  const bytes = response.stream.pipe(
    Stream.mapError(() => new ProviderError({ reason: "Cannot read the audio stream" })),
  );
  return new ProviderAudio({ bytes });
});

// Each page of an account has the account in `data-band` (October 2026)
const bandAttribute = /data-band="\{&quot;id&quot;:(\d+)/;

/**
 * The account ID of a `<name>.bandcamp.com` page, from one request. `null` for another site, a
 * custom domain or a page that does not exist.
 */
export const bandFromUrl = (url: string) => {
  const host = URL.parse(url)?.hostname ?? "";
  if (!host.endsWith(".bandcamp.com")) return Effect.succeed(null);

  return getText(HttpClientRequest.get(`https://${host}/`)).pipe(
    Effect.map((html) => html.match(bandAttribute)?.[1] ?? null),
    Effect.catchTag("HttpStatusError", (error) =>
      error.status === 404 ? Effect.succeed(null) : Effect.fail(error),
    ),
    Effect.mapError(providerError("Bandcamp")),
  );
};
