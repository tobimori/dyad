import type { SourceSummary } from "@dyad/domain";
import { Data } from "effect";

export class Directory extends Data.Class<{
  readonly directories: ReadonlyArray<string>;
  readonly songs: ReadonlyArray<SourceSummary>;
}> {}

const byText = (left: string, right: string) =>
  left.localeCompare(right, undefined, { sensitivity: "base" });

const artistName = (song: SourceSummary) => song.artist ?? "Unknown Artist";

// Groups songs by `key` into directories under `parent`. A `/` in a name becomes `|`, and a name
// that two groups share gets ` [2]`, ` [3]` and so on.
const group = (
  parent: string,
  songs: ReadonlyArray<SourceSummary>,
  key: (song: SourceSummary) => string,
  name: (song: SourceSummary) => string,
) => {
  const groups = new Map<string, { groupKey: string; name: string; songs: Array<SourceSummary> }>();
  for (const song of songs) {
    const existing = groups.get(key(song));
    if (existing !== undefined) {
      existing.songs.push(song);
      continue;
    }
    groups.set(key(song), {
      groupKey: key(song),
      name: name(song).replaceAll("/", "|"),
      songs: [song],
    });
  }

  const counts = new Map<string, number>();
  return [...groups.values()]
    .sort((left, right) => byText(left.name, right.name) || byText(left.groupKey, right.groupKey))
    .map(({ name, songs }) => {
      const count = (counts.get(name) ?? 0) + 1;
      counts.set(name, count);
      return { path: `${parent}/${count === 1 ? name : `${name} [${count}]`}`, songs };
    });
};

/**
 * The virtual directories: `Artists/<artist>/<album>`, `Albums/<album> - <artist>` and `Songs`.
 * Returns each directory by path; the root path is the empty string.
 */
export const directoryTree = (songs: ReadonlyArray<SourceSummary>) => {
  const tree = new Map<string, Directory>();
  const add = (
    path: string,
    directories: ReadonlyArray<string>,
    songs: ReadonlyArray<SourceSummary>,
  ) => tree.set(path, new Directory({ directories, songs }));

  const albumKey = (song: SourceSummary) =>
    song.albumRef ?? `${artistName(song)}\n${song.album ?? ""}`;
  const albumName = (song: SourceSummary) => song.album ?? "Unknown Album";

  // By name, as clients group by `Artist`; `markArtist` gives each artist its own name
  const artists = group("Artists", songs, artistName, artistName);
  for (const artist of artists) {
    const albums = group(artist.path, artist.songs, albumKey, albumName);
    for (const album of albums) add(album.path, [], album.songs);
    add(
      artist.path,
      albums.map((album) => album.path),
      [],
    );
  }

  const albums = group(
    "Albums",
    songs,
    albumKey,
    (song) => `${albumName(song)} - ${artistName(song)}`,
  );
  for (const album of albums) add(album.path, [], album.songs);

  add(
    "Artists",
    artists.map((artist) => artist.path),
    [],
  );
  add(
    "Albums",
    albums.map((album) => album.path),
    [],
  );
  add("Songs", [], songs);
  add("", ["Artists", "Albums", "Songs"], []);
  return tree;
};

/** Normalizes the path forms that clients send for the root and for directories */
export const directoryPath = (uri: string) => uri.replace(/^\/+|\/+$/g, "");

/** Lists the directory paths and songs below `path`, in depth-first order */
export const walk = (tree: ReadonlyMap<string, Directory>, path: string) => {
  const entries: Array<string | SourceSummary> = [];
  const visit = (current: string) => {
    const directory = tree.get(current);
    if (directory === undefined) return;
    for (const child of directory.directories) {
      entries.push(child);
      visit(child);
    }
    entries.push(...directory.songs);
  };

  // Clients such as Cantata build their library from this list, so it holds each song once
  if (path === "") {
    entries.push("Artists");
    visit("Artists");
    return entries;
  }
  visit(path);
  return entries;
};
