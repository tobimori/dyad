import { ProviderShelf, ProviderTrack } from "@dyad/plugin";
import { Effect, Schema } from "effect";
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
export const readCharts = (session: AppleSession) =>
  Effect.gen(function* () {
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
