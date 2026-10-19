import {
  ProviderAlbum,
  ProviderArtist,
  ProviderArtistCard,
  ProviderRelease,
  ProviderTrack,
} from "@dyad/plugin";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import {
  amp,
  AppleTrack,
  authorize,
  catalogSource,
  datePrefix,
  requestJson,
  songIncludes,
  typeSuffix,
} from "./api.ts";
import type { AppleSession } from "./api.ts";

const Artwork = Schema.optional(Schema.Struct({ url: Schema.String }));

const Related = Schema.optional(
  Schema.Struct({ data: Schema.Array(Schema.Struct({ id: Schema.String })) }),
);

export const AppleAlbum = Schema.Struct({
  id: Schema.String,
  attributes: Schema.Struct({
    name: Schema.String,
    artistName: Schema.String,
    releaseDate: Schema.optional(Schema.String),
    isSingle: Schema.optional(Schema.Boolean),
    isCompilation: Schema.optional(Schema.Boolean),
    trackCount: Schema.optional(Schema.Int),
    contentRating: Schema.optional(Schema.String),
    artwork: Artwork,
    upc: Schema.optional(Schema.String),
    recordLabel: Schema.optional(Schema.String),
  }),
  relationships: Schema.optional(Schema.Struct({ artists: Related })),
});

const AppleArtist = Schema.Struct({
  id: Schema.String,
  attributes: Schema.Struct({ name: Schema.String, artwork: Artwork }),
});

const View = <S extends Schema.Top>(item: S) =>
  Schema.optional(
    Schema.Struct({ data: Schema.Array(item), next: Schema.optional(Schema.String) }),
  );

const AlbumView = View(AppleAlbum);

const ArtistResponse = Schema.Struct({
  data: Schema.NonEmptyArray(
    Schema.Struct({
      ...AppleArtist.fields,
      views: Schema.Struct({
        "top-songs": View(AppleTrack),
        "similar-artists": View(AppleArtist),
        "full-albums": AlbumView,
        singles: AlbumView,
        "compilation-albums": AlbumView,
        "live-albums": AlbumView,
        "appears-on-albums": AlbumView,
      }),
    }),
  ),
});

const AlbumResponse = Schema.Struct({
  data: Schema.NonEmptyArray(
    Schema.Struct({
      ...AppleAlbum.fields,
      relationships: Schema.Struct({
        artists: Related,
        tracks: Schema.Struct({ data: Schema.Array(AppleTrack) }),
      }),
    }),
  ),
});

const artwork = (image: { readonly url: string } | undefined) =>
  image?.url.replace("{w}", "600").replace("{h}", "600") ?? null;

const primaryTypeOf = (album: typeof AppleAlbum.Type) => {
  const suffix = album.attributes.name.match(typeSuffix)?.[1];
  if (suffix === "EP") return "ep";
  if (suffix === "Single" || album.attributes.isSingle === true) return "single";
  return "album";
};

export const toRelease = (album: typeof AppleAlbum.Type, artistId: string | null, live: boolean) =>
  new ProviderRelease({
    externalId: album.id,
    title: album.attributes.name.replace(typeSuffix, ""),
    artist: album.attributes.artistName,
    artistId: album.relationships?.artists?.data[0]?.id ?? artistId,
    releaseDate: album.attributes.releaseDate?.match(datePrefix)?.[0] ?? null,
    primaryType: primaryTypeOf(album),
    secondaryTypes: [
      ...(album.attributes.isCompilation === true ? (["compilation"] as const) : []),
      ...(live ? (["live"] as const) : []),
    ],
    explicit: album.attributes.contentRating === "explicit",
    trackCount: album.attributes.trackCount ?? null,
    artworkUrl: artwork(album.attributes.artwork),
    upc: album.attributes.upc ?? null,
    label: album.attributes.recordLabel ?? null,
  });

export const toTrack = (song: AppleTrack) =>
  new ProviderTrack({
    disc: song.attributes.discNumber ?? null,
    number: song.attributes.trackNumber ?? null,
    source: catalogSource(song),
    // Apple leaves out `playParams` for songs that the storefront does not stream
    streamable: song.attributes.playParams !== undefined,
  });

const toCard = (artist: typeof AppleArtist.Type) =>
  new ProviderArtistCard({
    externalId: artist.id,
    name: artist.attributes.name,
    artworkUrl: artwork(artist.attributes.artwork),
  });

export const includes = { ...songIncludes, "include[albums]": "artists" };

// A view has 10 items and a `next` link. One more request gives up to 100 items.
const allAlbums = Effect.fn("allAlbums")(function* (
  session: AppleSession,
  view: typeof AlbumView.Type,
) {
  if (view?.next === undefined) return view?.data ?? [];

  const request = HttpClientRequest.get(new URL(view.next, amp)).pipe(
    HttpClientRequest.setUrlParams({ ...includes, limit: 100 - view.data.length }),
    authorize(session),
  );
  const rest = yield* requestJson(
    request,
    Schema.Struct({ data: Schema.Array(AppleAlbum) }),
    "artist view",
  );
  return [...view.data, ...rest.data];
});

export const readArtist = Effect.fn("readArtist")(function* (
  session: AppleSession,
  artistId: string,
) {
  const request = HttpClientRequest.get(
    `${amp}/v1/catalog/${session.storefront}/artists/${encodeURIComponent(artistId)}`,
  ).pipe(
    HttpClientRequest.setUrlParams({
      ...includes,
      views:
        "top-songs,similar-artists,full-albums,singles,compilation-albums,live-albums,appears-on-albums",
    }),
    authorize(session),
  );
  const [artist] = (yield* requestJson(request, ArtistResponse, "artist")).data;
  const views = artist.views;

  const [albums, singles, compilations, live, appearsOn] = yield* Effect.all(
    [
      allAlbums(session, views["full-albums"]),
      allAlbums(session, views.singles),
      allAlbums(session, views["compilation-albums"]),
      allAlbums(session, views["live-albums"]),
      allAlbums(session, views["appears-on-albums"]),
    ],
    { concurrency: "unbounded" },
  );

  return new ProviderArtist({
    artist: toCard(artist),
    topTracks: (views["top-songs"]?.data ?? []).map(toTrack),
    tracks: [],
    releases: [
      ...[...albums, ...singles, ...compilations].map((album) =>
        toRelease(album, artist.id, false),
      ),
      ...live.map((album) => toRelease(album, artist.id, true)),
    ],
    appearsOn: appearsOn.map((album) => toRelease(album, null, false)),
    similar: (views["similar-artists"]?.data ?? []).map(toCard),
  });
});

export const readAlbum = Effect.fn("readAlbum")(function* (session: AppleSession, albumId: string) {
  const request = HttpClientRequest.get(
    `${amp}/v1/catalog/${session.storefront}/albums/${encodeURIComponent(albumId)}`,
  ).pipe(
    HttpClientRequest.setUrlParams({ ...songIncludes, include: "tracks,artists" }),
    authorize(session),
  );
  const [album] = (yield* requestJson(request, AlbumResponse, "album")).data;

  return new ProviderAlbum({
    release: toRelease(album, null, false),
    tracks: album.relationships.tracks.data.filter((track) => track.type === "songs").map(toTrack),
  });
});
