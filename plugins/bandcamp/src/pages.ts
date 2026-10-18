import {
  CreditedArtist,
  ProviderAlbum,
  ProviderArtist,
  ProviderArtistCard,
  ProviderError,
  ProviderRelease,
  ProviderSource,
  ProviderTrack,
} from "@dyad/plugin";
import { getJson, providerError } from "@dyad/plugin/http";
import { DateTime, Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { detailsUrl } from "./api.ts";

const bandUrl = "https://bandcamp.com/api/mobile/25/band_details";

// Bandcamp answers status 200 with an error object, for example for a deleted band
const BandcampError = Schema.Struct({ error: Schema.Literal(true), error_message: Schema.String });

const Band = Schema.Struct({
  id: Schema.Int,
  name: Schema.String,
  bio_image_id: Schema.optional(Schema.NullOr(Schema.Int)),
  // A label account lists the releases of all its artists
  discography: Schema.Array(
    Schema.Struct({
      item_id: Schema.Int,
      item_type: Schema.String,
      title: Schema.String,
      artist_name: Schema.optional(Schema.NullOr(Schema.String)),
      band_name: Schema.String,
      band_id: Schema.Int,
      art_id: Schema.optional(Schema.NullOr(Schema.Int)),
      release_date: Schema.optional(Schema.NullOr(Schema.String)),
    }),
  ),
});

const Release = Schema.Struct({
  id: Schema.Int,
  type: Schema.Literals(["a", "t"]),
  title: Schema.String,
  tralbum_artist: Schema.optional(Schema.NullOr(Schema.String)),
  art_id: Schema.optional(Schema.NullOr(Schema.Int)),
  /** Unix seconds */
  release_date: Schema.optional(Schema.NullOr(Schema.Finite)),
  band: Schema.Struct({ band_id: Schema.Int, name: Schema.String }),
  tracks: Schema.Array(
    Schema.Struct({
      track_id: Schema.Int,
      title: Schema.String,
      track_num: Schema.optional(Schema.NullOr(Schema.Int)),
      band_name: Schema.optional(Schema.NullOr(Schema.String)),
      /** Seconds */
      duration: Schema.optional(Schema.NullOr(Schema.Finite)),
      is_streamable: Schema.Boolean,
    }),
  ),
});

// The release type, the band and the release, because `tralbum_details` needs all three
const AlbumId = Schema.TemplateLiteralParser([
  Schema.Literals(["a", "t"]),
  "-",
  Schema.Int,
  "-",
  Schema.Int,
]);

const albumId = (type: "a" | "t", bandId: number, id: number) => `${type}-${bandId}-${id}`;

// Image format `_10` is the full-size JPEG
const releaseArt = (artId: number | null | undefined) =>
  artId === undefined || artId === null ? null : `https://f4.bcbits.com/img/a${artId}_10.jpg`;

// Text such as `01 Jan 2023 05:53:43 GMT`, or milliseconds
const isoDate = (date: string | number | null | undefined) =>
  date === undefined || date === null
    ? null
    : Option.getOrNull(Option.map(DateTime.make(date), DateTime.formatIsoDateUtc));

const fail = (error: typeof BandcampError.Type) =>
  Effect.fail(new ProviderError({ reason: `Bandcamp: ${error.error_message}` }));

/** The releases of a Bandcamp account. Bandcamp has no top tracks and no similar artists. */
export const readBand = (bandId: string) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.post(bandUrl).pipe(
      HttpClientRequest.bodyJsonUnsafe({ band_id: Number(bandId) }),
    );
    const band = yield* getJson(request, Schema.Union([Band, BandcampError])).pipe(
      Effect.mapError(providerError("Bandcamp")),
    );
    if ("error" in band) return yield* fail(band);

    const image = band.bio_image_id;
    return new ProviderArtist({
      artist: new ProviderArtistCard({
        externalId: String(band.id),
        name: band.name,
        artworkUrl:
          image === undefined || image === null
            ? null
            : `https://f4.bcbits.com/img/${image}_10.jpg`,
      }),
      topTracks: [],
      tracks: [],
      releases: band.discography.flatMap((item) => {
        if (item.item_type !== "album" && item.item_type !== "track") return [];
        const type = item.item_type === "album" ? "a" : "t";

        return [
          new ProviderRelease({
            externalId: albumId(type, item.band_id, item.item_id),
            title: item.title,
            artist: item.artist_name ?? item.band_name,
            artistId: String(item.band_id),
            releaseDate: isoDate(item.release_date),
            // Bandcamp does not separate EPs from albums
            primaryType: type === "t" ? "single" : null,
            secondaryTypes: [],
            explicit: false,
            trackCount: null,
            artworkUrl: releaseArt(item.art_id),
          }),
        ];
      }),
      appearsOn: [],
      similar: [],
    });
  });

export const readRelease = (externalId: string) =>
  Effect.gen(function* () {
    const [type, , bandId, , id] = yield* Schema.decodeUnknownEffect(AlbumId)(externalId).pipe(
      Effect.mapError(() => new ProviderError({ reason: "Invalid album ID" })),
    );
    const request = HttpClientRequest.get(detailsUrl).pipe(
      HttpClientRequest.setUrlParams({ band_id: bandId, tralbum_type: type, tralbum_id: id }),
    );
    const release = yield* getJson(request, Schema.Union([Release, BandcampError])).pipe(
      Effect.mapError(providerError("Bandcamp")),
    );
    if ("error" in release) return yield* fail(release);

    const artist = release.tralbum_artist ?? release.band.name;
    const artworkUrl = releaseArt(release.art_id);
    const account = new CreditedArtist({ id: String(bandId), name: release.band.name });

    return new ProviderAlbum({
      release: new ProviderRelease({
        externalId,
        title: release.title,
        artist,
        artistId: String(bandId),
        releaseDate: isoDate(
          release.release_date === undefined || release.release_date === null
            ? null
            : release.release_date * 1000,
        ),
        primaryType: type === "t" ? "single" : null,
        secondaryTypes: [],
        explicit: false,
        trackCount: release.tracks.length,
        artworkUrl,
      }),
      tracks: release.tracks.map(
        (track) =>
          new ProviderTrack({
            disc: null,
            number: track.track_num ?? null,
            streamable: track.is_streamable,
            source: new ProviderSource({
              externalId: `${bandId}-${track.track_id}`,
              title: track.title,
              artist: track.band_name ?? artist,
              album: type === "a" ? release.title : null,
              durationMs:
                track.duration === undefined || track.duration === null
                  ? null
                  : Math.round(track.duration * 1000),
              isrc: null,
              container: "mp3",
              codec: "mp3",
              lossless: false,
              encrypted: false,
              artworkUrl,
              artists: [],
              explicit: null,
              bitrate: 128_000,
              uploader: account,
              albumId: externalId,
            }),
          }),
      ),
    });
  });
