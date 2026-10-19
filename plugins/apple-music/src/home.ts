import { ProviderShelf, ProviderTrack, SuggestionShelf } from "@dyad/plugin";
import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { amp, AppleTrack, authorize, requestJson } from "./api.ts";
import type { AppleSession } from "./api.ts";
import { AppleAlbum, includes, toRelease, toTrack } from "./pages.ts";

const Charts = <S extends Schema.Top>(item: S) =>
  Schema.Array(Schema.Struct({ data: Schema.Array(item) }));

const ChartsResponse = Schema.Struct({
  results: Schema.Struct({ songs: Charts(AppleTrack), albums: Charts(AppleAlbum) }),
});

/** The most played songs and albums of the user's storefront */
export const readCharts = Effect.fn("readCharts")(function* (session: AppleSession) {
  const request = HttpClientRequest.get(`${amp}/v1/catalog/${session.storefront}/charts`).pipe(
    HttpClientRequest.setUrlParams({ ...includes, types: "songs,albums", limit: 25 }),
    authorize(session),
  );
  const { results } = yield* requestJson(request, ChartsResponse, "charts");

  // Apple names the charts in the language of the storefront, for example `Top-Titel` (October 2026)
  return [
    ...results.songs.map(
      (chart) =>
        new ProviderShelf({
          title: "Top songs",
          // The position on the album means nothing in a chart
          tracks: chart.data.map(
            (song) => new ProviderTrack({ ...toTrack(song), disc: null, number: null }),
          ),
          releases: [],
        }),
    ),
    ...results.albums.map(
      (chart) =>
        new ProviderShelf({
          title: "Top albums",
          tracks: [],
          releases: chart.data.map((album) => toRelease(album, null, false)),
        }),
    ),
  ];
});

// Heavy rotation and recommendations also hold playlists and stations, which are not releases
const CatalogAlbum = Schema.Struct({ type: Schema.Literal("albums"), ...AppleAlbum.fields });

const albumsOf = (items: ReadonlyArray<unknown>) =>
  items.flatMap((item) =>
    Option.match(Schema.decodeUnknownOption(CatalogAlbum)(item), {
      onNone: () => [],
      onSome: (album) => [toRelease(album, null, false)],
    }),
  );

const HeavyRotation = Schema.Struct({ data: Schema.Array(Schema.Unknown) });

const Recommendations = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      attributes: Schema.Struct({
        title: Schema.optional(Schema.Struct({ stringForDisplay: Schema.String })),
      }),
      relationships: Schema.optional(
        Schema.Struct({ contents: Schema.Struct({ data: Schema.Array(Schema.Unknown) }) }),
      ),
    }),
  ),
});

/** The albums that the subscriber plays most, and Apple's recommendations for the subscriber */
export const readPersonal = Effect.fn("readPersonal")(function* (session: AppleSession) {
  const rotation = yield* requestJson(
    HttpClientRequest.get(`${amp}/v1/me/history/heavy-rotation`).pipe(
      HttpClientRequest.setUrlParams({ limit: 10 }),
      authorize(session),
    ),
    HeavyRotation,
    "heavy rotation",
  );
  const recommendations = yield* requestJson(
    HttpClientRequest.get(`${amp}/v1/me/recommendations`).pipe(
      HttpClientRequest.setUrlParams({ limit: 10 }),
      authorize(session),
    ),
    Recommendations,
    "recommendations",
  );

  return [
    new SuggestionShelf({
      title: "Heavy rotation",
      songs: [],
      releases: albumsOf(rotation.data),
    }),
    ...recommendations.data.map(
      (group) =>
        new SuggestionShelf({
          title: group.attributes.title?.stringForDisplay ?? "Recommended",
          songs: [],
          releases: albumsOf(group.relationships?.contents.data ?? []),
        }),
    ),
  ].filter((shelf) => shelf.releases.length > 0);
});
