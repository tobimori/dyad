import { Plugin, Provider } from "@dyad/plugin";
import { Effect } from "effect";
import { HttpClient } from "effect/http";

import { detailsCache, provider, resolveTrack, searchTracks } from "./api.ts";
import { readBand, readRelease } from "./pages.ts";

/**
 * Searches the public Bandcamp catalog and plays the public 128 kbps MP3 streams. Bandcamp needs
 * no account for this.
 */
export const bandcampPlugin = new Plugin({
  id: "dyad.bandcamp",
  setup: (context) =>
    Effect.gen(function* () {
      const services = yield* Effect.context<HttpClient.HttpClient>();
      const details = yield* detailsCache;

      yield* context.provider.add(
        provider,
        new Provider({
          name: "Bandcamp",
          resolve: (externalId) => resolveTrack(externalId).pipe(Effect.provide(services)),
          search: (query) => searchTracks(details, query).pipe(Effect.provide(services)),
          artist: (bandId) => readBand(bandId).pipe(Effect.provide(services)),
          album: (albumId) => readRelease(albumId).pipe(Effect.provide(services)),
          metadataPriority: 20,
          uploads: true,
          download: { leaseDays: 30 },
        }),
      );
    }),
});
