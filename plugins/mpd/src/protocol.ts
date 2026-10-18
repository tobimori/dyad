import type { SourceSummary } from "@dyad/domain";
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
export const parseLine = (line: string) =>
  Effect.gen(function* () {
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

/** The tags that `SourceSummary` has, in the order of the song output */
export const tags = ["Artist", "Album", "Title"] as const;
export type Tag = (typeof tags)[number];

/** Finds a tag of `tags` without regard to case, because clients send `artist` or `ARTIST` */
export const tagNamed = (name: string) =>
  Option.fromNullishOr(tags.find((tag) => tag.toLowerCase() === name.toLowerCase()));

export const tagValue = (song: SourceSummary, tag: Tag) =>
  ({ Artist: song.artist, Album: song.album, Title: song.title })[tag];

// MPD 0.24 gives the `Artist` of a song without `AlbumArtist` in filters, groups and `list`
const queryTags = [...tags.map((tag) => [tag, tag] as const), ["AlbumArtist", "Artist"] as const];

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
    return enabled.has(tag) && value !== null ? [field(tag, value)] : [];
  }),
  ...(song.durationMs === null
    ? []
    : [
        field("Time", Math.round(song.durationMs / 1000)),
        field("duration", seconds(song.durationMs)),
      ]),
];
