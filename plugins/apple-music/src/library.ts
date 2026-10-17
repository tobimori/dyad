import { LibraryPlaylist, LibraryProbe, LibrarySnapshot, LibrarySong } from "@dyad/plugin";
import { getJson, HttpStatusError } from "@dyad/plugin/http";
import type { makePacer } from "@dyad/plugin/http";
import { Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { amp, appleError, AppleTrack, authorize, catalogSource, requestJson } from "./api.ts";
import type { AppleSession } from "./api.ts";

// Apple throttles fast reads, and a 429 stops the sync. All library reads of the plugin must share
// one pacer of 1 second.
type Pace = Effect.Success<ReturnType<typeof makePacer>>;

// Library songs and playlist tracks have the same shape
const LibrarySongItem = Schema.Struct({
  id: Schema.String,
  attributes: Schema.Struct({
    name: Schema.String,
    artistName: Schema.optional(Schema.String),
    albumName: Schema.optional(Schema.String),
    durationInMillis: Schema.optional(Schema.Finite),
    playParams: Schema.optional(Schema.Struct({ catalogId: Schema.optional(Schema.String) })),
  }),
  // `include=catalog` adds the catalog song, if the storefront has it
  relationships: Schema.optional(
    Schema.Struct({ catalog: Schema.Struct({ data: Schema.Array(AppleTrack) }) }),
  ),
});

const LibraryPlaylistItem = Schema.Struct({
  id: Schema.String,
  attributes: Schema.Struct({
    name: Schema.String,
    lastModifiedDate: Schema.optional(Schema.String),
  }),
});

const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ data: Schema.Array(item), next: Schema.optional(Schema.String) });

const ProbePage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
  meta: Schema.Struct({ total: Schema.Finite }),
});

// Remote IDs start with `i.` and catalog IDs are numbers, so the core can use a remote ID where no
// catalog ID exists
const toLibrarySong = (item: typeof LibrarySongItem.Type) => {
  const attributes = item.attributes;
  const catalogSong = item.relationships?.catalog.data[0];

  return new LibrarySong({
    remoteId: item.id,
    // A song that is not released yet has a catalog song, but no `catalogId` (October 2026)
    catalogId: attributes.playParams?.catalogId ?? catalogSong?.id ?? null,
    source: catalogSong?.attributes.playParams === undefined ? null : catalogSource(catalogSong),
    title: attributes.name,
    artist: attributes.artistName ?? null,
    album: attributes.albumName ?? null,
    durationMs: attributes.durationInMillis ?? null,
  });
};

// Apple sometimes answers 404 or an empty page after `next` promised more items. Then the snapshot
// keeps the items so far, but is incomplete.
const readPages = <S extends Schema.Top>(
  pace: Pace,
  request: HttpClientRequest.HttpClientRequest,
  item: S,
  stage: string,
) =>
  Effect.gen(function* () {
    const items: Array<S["Type"]> = [];

    while (true) {
      const pageRequest = request.pipe(HttpClientRequest.setUrlParam("offset", `${items.length}`));
      const page = yield* pace(getJson(pageRequest, Page(item))).pipe(
        Effect.asSome,
        Effect.catchIf(
          (error) => error instanceof HttpStatusError && error.status === 404,
          () => Effect.succeedNone,
        ),
        Effect.mapError(appleError(stage, pageRequest)),
      );
      if (Option.isNone(page)) {
        return new LibrarySnapshot({ items, incompleteReason: `404 at offset ${items.length}` });
      }

      if (page.value.data.length === 0 && page.value.next !== undefined) {
        return new LibrarySnapshot({
          items,
          incompleteReason: `empty page at offset ${items.length}`,
        });
      }

      items.push(...page.value.data);
      if (page.value.next === undefined) {
        return new LibrarySnapshot({ items, incompleteReason: null });
      }
    }
  });

const libraryRequest = (session: AppleSession, path: string) =>
  HttpClientRequest.get(`${amp}${path}`).pipe(
    HttpClientRequest.setUrlParam("limit", "100"),
    authorize(session),
  );

export const readLibrarySongs = (pace: Pace, session: AppleSession) =>
  Effect.gen(function* () {
    const request = libraryRequest(session, "/v1/me/library/songs").pipe(
      HttpClientRequest.setUrlParam("include", "catalog"),
    );
    const snapshot = yield* readPages(pace, request, LibrarySongItem, "library songs");

    return new LibrarySnapshot({
      items: snapshot.items.map(toLibrarySong),
      incompleteReason: snapshot.incompleteReason,
    });
  });

export const readPlaylists = (pace: Pace, session: AppleSession) =>
  Effect.gen(function* () {
    const request = libraryRequest(session, "/v1/me/library/playlists");
    const snapshot = yield* readPages(pace, request, LibraryPlaylistItem, "library playlists");

    return new LibrarySnapshot({
      items: snapshot.items.map(
        (item) =>
          new LibraryPlaylist({
            remoteId: item.id,
            name: item.attributes.name,
            version: item.attributes.lastModifiedDate ?? null,
          }),
      ),
      incompleteReason: snapshot.incompleteReason,
    });
  });

/** The items are in playlist order. A song can be in the playlist more than once. */
export const readPlaylistTracks = (pace: Pace, session: AppleSession, playlistId: string) =>
  Effect.gen(function* () {
    const path = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`;
    const request = libraryRequest(session, path).pipe(
      HttpClientRequest.setUrlParam("include", "catalog"),
    );
    const snapshot = yield* readPages(pace, request, LibrarySongItem, "playlist tracks");

    return new LibrarySnapshot({
      items: snapshot.items.map(toLibrarySong),
      incompleteReason: snapshot.incompleteReason,
    });
  });

/** One request. The newest song and the count change when songs are added or removed. */
export const probeLibrary = (pace: Pace, session: AppleSession) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${amp}/v1/me/library/songs`).pipe(
      HttpClientRequest.setUrlParams({ limit: "1", sort: "-dateAdded" }),
      authorize(session),
    );
    const page = yield* pace(requestJson(request, ProbePage, "library probe"));
    const newestId = page.data[0]?.id ?? "";

    return new LibraryProbe({ version: `${page.meta.total}:${newestId}`, total: page.meta.total });
  });
