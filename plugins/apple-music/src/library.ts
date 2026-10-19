import { LibraryPlaylist, LibraryProbe, LibrarySnapshot, LibrarySong } from "@dyad/plugin";
import { getJson, HttpStatusError, send } from "@dyad/plugin/http";
import type { makePacer } from "@dyad/plugin/http";
import { Array as Arr, Effect, Option, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import {
  amp,
  AppleMusicError,
  appleError,
  AppleTrack,
  authorize,
  catalogSource,
  requestJson,
  songIncludes,
} from "./api.ts";
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
const readPages = Effect.fnUntraced(function* <S extends Schema.Top>(
  pace: Pace,
  request: HttpClientRequest.HttpClientRequest,
  item: S,
  stage: string,
) {
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

export const readLibrarySongs = Effect.fn("readLibrarySongs")(function* (
  pace: Pace,
  session: AppleSession,
) {
  const request = libraryRequest(session, "/v1/me/library/songs").pipe(
    HttpClientRequest.setUrlParams({ include: "catalog", ...songIncludes }),
  );
  const snapshot = yield* readPages(pace, request, LibrarySongItem, "library songs");

  return new LibrarySnapshot({
    items: snapshot.items.map(toLibrarySong),
    incompleteReason: snapshot.incompleteReason,
  });
});

export const readPlaylists = Effect.fn("readPlaylists")(function* (
  pace: Pace,
  session: AppleSession,
) {
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
export const readPlaylistTracks = Effect.fn("readPlaylistTracks")(function* (
  pace: Pace,
  session: AppleSession,
  playlistId: string,
) {
  const path = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`;
  const request = libraryRequest(session, path).pipe(
    HttpClientRequest.setUrlParams({ include: "catalog", ...songIncludes }),
  );
  const snapshot = yield* readPages(pace, request, LibrarySongItem, "playlist tracks");

  return new LibrarySnapshot({
    items: snapshot.items.map(toLibrarySong),
    incompleteReason: snapshot.incompleteReason,
  });
});

const CreatedPlaylist = Schema.Struct({
  data: Schema.NonEmptyArray(Schema.Struct({ id: Schema.String })),
});

const encodeFailed = (stage: string) => () =>
  Effect.fail(new AppleMusicError({ stage, reason: "Cannot encode the request" }));

// Apple's API can create library playlists and add songs to them, but it answers 403 or 401 to
// removals, moves and deletes (October 2026)
export const createPlaylist = Effect.fn("createPlaylist")(
  function* (pace: Pace, session: AppleSession, name: string) {
    const request = yield* HttpClientRequest.post(`${amp}/v1/me/library/playlists`).pipe(
      authorize(session),
      HttpClientRequest.bodyJson({ attributes: { name } }),
    );
    const response = yield* pace(requestJson(request, CreatedPlaylist, "create playlist"));
    return response.data[0].id;
  },
  (effect) => effect.pipe(Effect.catchTag("HttpBodyError", encodeFailed("create playlist"))),
);

/** Adds catalog songs at the end of a library playlist */
export const addPlaylistSongs = (
  pace: Pace,
  session: AppleSession,
  playlistId: string,
  songIds: ReadonlyArray<string>,
) =>
  Effect.forEach(
    Arr.chunksOf(songIds, 100),
    (chunk) =>
      Effect.gen(function* () {
        const path = `/v1/me/library/playlists/${encodeURIComponent(playlistId)}/tracks`;
        const request = yield* HttpClientRequest.post(`${amp}${path}`).pipe(
          authorize(session),
          HttpClientRequest.bodyJson({ data: chunk.map((id) => ({ id, type: "songs" })) }),
        );
        yield* pace(send(request)).pipe(Effect.mapError(appleError("add playlist songs", request)));
      }).pipe(Effect.catchTag("HttpBodyError", encodeFailed("add playlist songs"))),
    { discard: true },
  );

/** One request. The newest song and the count change when songs are added or removed. */
export const probeLibrary = Effect.fn("probeLibrary")(function* (
  pace: Pace,
  session: AppleSession,
) {
  const request = HttpClientRequest.get(`${amp}/v1/me/library/songs`).pipe(
    HttpClientRequest.setUrlParams({ limit: "1", sort: "-dateAdded" }),
    authorize(session),
  );
  const page = yield* pace(requestJson(request, ProbePage, "library probe"));
  const newestId = page.data[0]?.id ?? "";

  return new LibraryProbe({ version: `${page.meta.total}:${newestId}`, total: page.meta.total });
});
