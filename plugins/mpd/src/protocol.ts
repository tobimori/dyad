import { SourceSummary } from "@dyad/domain";
import { Data, Effect, Option, Schema } from "effect";

/** An MPD error. The server sends it as `ACK [code@index] {command} message`. */
export class Ack extends Data.TaggedError("Ack")<{
  readonly code: number;
  readonly message: string;
}> {}

export const ackCode = {
  argument: 2,
  password: 3,
  permission: 4,
  unknown: 5,
  noExist: 50,
  playlistMax: 51,
  system: 52,
  playerSync: 55,
};

/** Lines, and the bytes of a binary chunk */
export type Response = ReadonlyArray<string | Uint8Array>;

const isSpace = (char: string | undefined) => char === " " || char === "\t";

/** Splits a request line into the command name and its arguments, which can be in double quotes */
export const parseLine = Effect.fn("parseLine")(function* (line: string) {
  const args: Array<string> = [];
  let index = 0;

  while (index < line.length) {
    if (isSpace(line[index])) {
      index += 1;
      continue;
    }
    if (line[index] !== '"') {
      const start = index;
      while (index < line.length && !isSpace(line[index]) && line[index] !== '"') index += 1;
      args.push(line.slice(start, index));
      continue;
    }

    let value = "";
    index += 1;
    while (index < line.length && line[index] !== '"') {
      if (line[index] === "\\") index += 1;
      value += line[index] ?? "";
      index += 1;
    }
    if (index >= line.length) {
      return yield* new Ack({ code: ackCode.unknown, message: "Missing closing '\"'" });
    }
    index += 1;
    if (index < line.length && !isSpace(line[index])) {
      return yield* new Ack({
        code: ackCode.unknown,
        message: "Space expected after closing '\"'",
      });
    }
    args.push(value);
  }

  const [name, ...rest] = args;
  if (name === undefined || !/^[a-z_]+$/.test(name)) {
    return yield* new Ack({ code: ackCode.unknown, message: "Invalid command" });
  }
  return { name, args: rest };
});

const songUriPrefix = "dyad:source:";

export const songUri = (sourceId: string) => `${songUriPrefix}${sourceId}`;

const isUuid = Schema.is(Schema.String.check(Schema.isUUID()));

export const sourceIdOf = (uri: string) => {
  const sourceId = uri.slice(songUriPrefix.length);
  return uri.startsWith(songUriPrefix) && isUuid(sourceId) ? Option.some(sourceId) : Option.none();
};

// mpc 0.35, ncmpc 0.54, ncmpcpp 0.10.1 and rmpc 0.11.0 show U+200B as nothing
const mark = "\u200B";

/** The name without the marks of `markArtist` */
export const plainName = (name: string) => name.replace(/\u200B+$/u, "");

export const hasMark = (name: string) => name.includes(mark);

/**
 * Gives each further artist of a name one more invisible mark, so that clients that group by
 * `Artist` show it in its own row. A mark does not change while the server runs.
 */
export const markArtist = (artistRefsByName: Map<string, Array<string>>, song: SourceSummary) => {
  const { artist, artistRef } = song;
  // Without a ref the song cannot tell its artist, so it gets the plain name
  if (artist === null || artistRef === null) return song;
  const refs = artistRefsByName.get(artist) ?? [];
  artistRefsByName.set(artist, refs);
  const known = refs.indexOf(artistRef);
  const index = known === -1 ? refs.push(artistRef) - 1 : known;
  return index === 0 ? song : new SourceSummary({ ...song, artist: artist + mark.repeat(index) });
};

/** The tags that `SourceSummary` has, in the order of the song output */
export const tags = ["Artist", "ArtistSort", "Album", "Title"] as const;
export type Tag = (typeof tags)[number];

/** Finds a tag of `tags` without regard to case, because clients send `artist` or `ARTIST` */
export const tagNamed = (name: string) =>
  Option.fromNullishOr(tags.find((tag) => tag.toLowerCase() === name.toLowerCase()));

export const tagValue = (song: SourceSummary, tag: Tag) =>
  ({
    Artist: song.artist,
    // Clients that sort by it keep the artists of a name together
    ArtistSort: song.artist === null ? null : plainName(song.artist),
    Album: song.album,
    Title: song.title,
  })[tag];

// MPD 0.24 gives the `Artist` of a song without `AlbumArtist` in filters, groups and `list`
const queryTags = [
  ...tags.map((tag) => [tag, tag] as const),
  ["AlbumArtist", "Artist"] as const,
  ["AlbumArtistSort", "ArtistSort"] as const,
];

/** The name of a tag in a filter, group or `list`, and the tag that gives its value */
export const queryTag = (name: string) =>
  Option.fromNullishOr(queryTags.find(([label]) => label.toLowerCase() === name.toLowerCase()));

/** MPD compares a tag that the song does not have, also a tag that Dyad does not know, as `""` */
export const tagText = (song: SourceSummary, name: string) =>
  Option.match(queryTag(name), {
    onNone: () => "",
    onSome: ([, tag]) => tagValue(song, tag) ?? "",
  });

/** Replaces line breaks, which would end the response line early */
export const field = (key: string, value: string | number) =>
  `${key}: ${String(value).replaceAll("\n", " ")}`;

export const seconds = (ms: number) => (ms / 1000).toFixed(3);

export const songLines = (song: SourceSummary, enabled: ReadonlySet<Tag>) => [
  field("file", songUri(song.id)),
  ...tags.flatMap((tag) => {
    const value = tagValue(song, tag);
    // MPD sends `ArtistSort` only when a file has one
    const sameAsArtist = tag === "ArtistSort" && value === song.artist;
    return enabled.has(tag) && value !== null && !sameAsArtist ? [field(tag, value)] : [];
  }),
  ...(song.durationMs === null
    ? []
    : [
        field("Time", Math.round(song.durationMs / 1000)),
        field("duration", seconds(song.durationMs)),
      ]),
];
