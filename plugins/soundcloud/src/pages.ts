import {
  ProviderAlbum,
  ProviderArtist,
  ProviderArtistCard,
  ProviderRelease,
  ProviderTrack,
} from "@dyad/plugin";
import { Array as Arr, Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

import { api, fullStream, requestApi, Track, trackSource } from "./api.ts";
import type { clientIdCache } from "./api.ts";

const User = Schema.Struct({
  id: Schema.Int,
  username: Schema.String,
  avatar_url: Schema.optional(Schema.NullOr(Schema.String)),
});

// A set embeds the first tracks in full and only the IDs of the others (October 2026)
const Playlist = Schema.Struct({
  id: Schema.Int,
  title: Schema.String,
  set_type: Schema.optional(Schema.NullOr(Schema.String)),
  release_date: Schema.optional(Schema.NullOr(Schema.String)),
  display_date: Schema.optional(Schema.NullOr(Schema.String)),
  track_count: Schema.optional(Schema.NullOr(Schema.Int)),
  artwork_url: Schema.optional(Schema.NullOr(Schema.String)),
  user: User,
  tracks: Schema.Array(Schema.Struct({ id: Schema.Int })),
});

const Collection = <S extends Schema.Top>(item: S) =>
  Schema.Struct({ collection: Schema.Array(item) });

// The API gives 100 pixel `-large` images; `-t500x500` is the same image larger
const large = (url: string | null | undefined) => url?.replace("-large.", "-t500x500.") ?? null;

const datePrefix = /^\d{4}(-\d{2}(-\d{2})?)?/;

// Playlists that are not albums have no `set_type`
const primaryTypeOf = (setType: string | null | undefined) => {
  if (setType === "ep" || setType === "single") return setType;
  if (setType === "album" || setType === "compilation") return "album";
  return null;
};

const toRelease = (set: typeof Playlist.Type) =>
  new ProviderRelease({
    externalId: String(set.id),
    title: set.title,
    artist: set.user.username,
    artistId: String(set.user.id),
    releaseDate: (set.release_date ?? set.display_date)?.match(datePrefix)?.[0] ?? null,
    primaryType: primaryTypeOf(set.set_type),
    secondaryTypes: set.set_type === "compilation" ? ["compilation"] : [],
    explicit: false,
    trackCount: set.track_count ?? set.tracks.length,
    artworkUrl: large(set.artwork_url),
  });

const toTrack = (track: Track, number: number | null) =>
  new ProviderTrack({
    disc: null,
    number,
    source: trackSource(track),
    // Go+ tracks play only as a snippet without an account
    streamable: fullStream(track) !== undefined,
  });

const toCard = (user: typeof User.Type) =>
  new ProviderArtistCard({
    externalId: String(user.id),
    name: user.username,
    artworkUrl: large(user.avatar_url),
  });

const get = <S extends Schema.Constraint>(
  withClientId: Effect.Success<typeof clientIdCache>,
  path: string,
  schema: S,
  params: Record<string, string | number> = {},
) =>
  requestApi(
    withClientId,
    HttpClientRequest.get(`${api}${path}`).pipe(HttpClientRequest.setUrlParams(params)),
    schema,
  );

/** The uploads of a user. For label accounts, this is the label. */
export const readUser = (withClientId: Effect.Success<typeof clientIdCache>, userId: string) =>
  Effect.gen(function* () {
    const path = `/users/${encodeURIComponent(userId)}`;
    const [user, topTracks, tracks, sets, related] = yield* Effect.all(
      [
        get(withClientId, path, User),
        get(withClientId, `${path}/toptracks`, Collection(Track), { limit: 10 }),
        get(withClientId, `${path}/tracks`, Collection(Track), { limit: 20 }),
        get(withClientId, `${path}/albums`, Collection(Playlist), { limit: 50 }),
        get(withClientId, `${path}/relatedartists`, Collection(User), { limit: 10 }),
      ],
      { concurrency: "unbounded" },
    );

    return new ProviderArtist({
      artist: toCard(user),
      topTracks: topTracks.collection.map((track) => toTrack(track, null)),
      tracks: tracks.collection.map((track) => toTrack(track, null)),
      releases: sets.collection.map(toRelease),
      appearsOn: [],
      similar: related.collection.map(toCard),
    });
  });

// `/tracks` takes up to 50 IDs (October 2026)
const idsPerRequest = 50;

/** A set and its tracks in order. Tracks that SoundCloud does not return are left out. */
export const readSet = (withClientId: Effect.Success<typeof clientIdCache>, setId: string) =>
  Effect.gen(function* () {
    const set = yield* get(withClientId, `/playlists/${encodeURIComponent(setId)}`, Playlist);

    const chunks = Arr.chunksOf(
      set.tracks.map((track) => track.id),
      idsPerRequest,
    );
    const found = yield* Effect.forEach(
      chunks,
      (ids) => get(withClientId, "/tracks", Schema.Array(Track), { ids: ids.join(",") }),
      { concurrency: "unbounded" },
    );
    const byId = new Map(found.flat().map((track) => [track.id, track]));

    return new ProviderAlbum({
      release: toRelease(set),
      tracks: set.tracks.flatMap((item, index) => {
        const track = byId.get(item.id);
        return track === undefined ? [] : [toTrack(track, index + 1)];
      }),
    });
  });
