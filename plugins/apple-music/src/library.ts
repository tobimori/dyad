import type { ProviderSource } from "@dyad/plugin";
import { getJson, HttpStatusError } from "@dyad/plugin/http";
import type { makePacer } from "@dyad/plugin/http";
import { Data, Effect, Option, Schema } from "effect";
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
    canEdit: Schema.Boolean,
    lastModifiedDate: Schema.optional(Schema.DateFromString),
  }),
});

const Page = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ data: Schema.Array(item), next: Schema.optional(Schema.String) });

const ProbePage = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String })),
  meta: Schema.Struct({ total: Schema.Finite }),
});

/** Items of one remote list. Only a complete snapshot can show that an item was removed. */
export class LibrarySnapshot<A> extends Data.Class<{
  readonly items: ReadonlyArray<A>;
  readonly complete: boolean;
}> {}

/** One song of the user's library or of a library playlist */
export class LibrarySong extends Data.Class<{
  /** `i.` ID that removes the song from the library */
  readonly libraryId: string;
  readonly catalogId: string | null;
  readonly title: string;
  readonly artist: string | null;
  readonly album: string | null;
  readonly durationMs: number | null;
  /**
   * `null` for uploads, iTunes Match songs, purchases and songs that the storefront does not have.
   * Dyad cannot play them.
   */
  readonly source: ProviderSource | null;
}> {}

export class LibraryPlaylist extends Data.Class<{
  /** `p.` ID */
  readonly libraryId: string;
  readonly name: string;
  /** Apple also sets `false` for the automatic Favorite Songs playlist */
  readonly canEdit: boolean;
  readonly lastModifiedDate: Date | null;
}> {}

/** A change of `total` or `newestId` shows that songs were added or removed */
export class LibraryProbe extends Data.Class<{
  readonly total: number;
  readonly newestId: string | null;
}> {}

const toLibrarySong = (item: typeof LibrarySongItem.Type) => {
  const attributes = item.attributes;
  const catalogSong = item.relationships?.catalog.data[0];

  return new LibrarySong({
    libraryId: item.id,
    catalogId: attributes.playParams?.catalogId ?? null,
    title: attributes.name,
    artist: attributes.artistName ?? null,
    album: attributes.albumName ?? null,
    durationMs: attributes.durationInMillis ?? null,
    source: catalogSong === undefined ? null : catalogSource(catalogSong),
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
      if (Option.isNone(page)) return new LibrarySnapshot({ items, complete: false });

      if (page.value.data.length === 0 && page.value.next !== undefined) {
        return new LibrarySnapshot({ items, complete: false });
      }

      items.push(...page.value.data);
      if (page.value.next === undefined) return new LibrarySnapshot({ items, complete: true });
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
      complete: snapshot.complete,
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
            libraryId: item.id,
            name: item.attributes.name,
            canEdit: item.attributes.canEdit,
            lastModifiedDate: item.attributes.lastModifiedDate ?? null,
          }),
      ),
      complete: snapshot.complete,
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
      complete: snapshot.complete,
    });
  });

/** One request that shows whether a full read of the library songs is necessary */
export const probeLibrary = (pace: Pace, session: AppleSession) =>
  Effect.gen(function* () {
    const request = HttpClientRequest.get(`${amp}/v1/me/library/songs`).pipe(
      HttpClientRequest.setUrlParams({ limit: "1", sort: "-dateAdded" }),
      authorize(session),
    );
    const page = yield* pace(requestJson(request, ProbePage, "library probe"));

    return new LibraryProbe({ total: page.meta.total, newestId: page.data[0]?.id ?? null });
  });
