import { PartialDate, ReleaseType, SecondaryType } from "@dyad/domain";
import { Schema } from "effect";

import type { Tags } from "./sources.ts";

/** The `album_type` assertion: the type of the release of the `album` of the same origin */
export const AlbumType = Schema.Struct({
  primary: Schema.NullOr(ReleaseType),
  secondary: Schema.Array(SecondaryType),
});

/** The `release_date` assertion: the date of the release of the `album` of the same origin */
export const ReleaseDate = PartialDate;

const datePrefix = /^\d{4}(-\d{2}(-\d{2})?)?/;

/** FFmpeg (`node-av` 6.1.1) keeps the ID3v2.4 frame name `TDOR` as the key of an MP3 original date */
export const tagReleaseDate = (tags: typeof Tags.Type) =>
  (tags.originaldate ?? tags.tdor ?? tags.date)?.match(datePrefix)?.[0] ?? null;

/**
 * Picard writes `releasetype`, for example `album; compilation`. FFmpeg (`node-av` 6.1.1) gives the
 * MP3 frame `TXXX:MusicBrainz Album Type` the key `musicbrainz album type`.
 */
export const tagReleaseTypes = (tags: typeof Tags.Type) =>
  tags.releasetype ?? tags["musicbrainz album type"];

/** The types of `tagReleaseTypes`, and the compilation flag of the tags */
export const albumTypeOf = (types: string | undefined, compilation: boolean) => {
  const words = (types ?? "")
    .toLowerCase()
    .split(/[;/]/)
    .map((type) => type.trim());
  return AlbumType.make({
    primary: words.find(Schema.is(ReleaseType)) ?? null,
    secondary: SecondaryType.literals.filter(
      (type) => words.includes(type) || (type === "compilation" && compilation),
    ),
  });
};

export const tagAlbumType = (tags: typeof Tags.Type) =>
  albumTypeOf(tagReleaseTypes(tags), tags.compilation === "1");

// Bracketed suffixes with an edition word at the end of an album name, for example
// `(Deluxe Edition)`, `(Bonus Track Version)` or `[2011 Remaster]`
const editionSuffixes =
  /(?:\s*[([][^()[\]]*\b(?:deluxe|edition|remaster(?:ed)?|expanded|anniversary|bonus|reissue|special|collector'?s|international)\b[^()[\]]*[)\]])+$/i;

/** The album name without its edition suffixes, for example `Album` for `Album (Deluxe) [Remastered]` */
export const editionBase = (album: string) => album.replace(editionSuffixes, "") || album;
