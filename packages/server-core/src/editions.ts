import { PartialDate, ReleaseType, SecondaryType } from "@dyad/domain";
import { Schema } from "effect";

import type { Tags } from "./sources.ts";

/** The `artist_credit` assertion of a recording or an edition */
export const ArtistCredit = Schema.Struct({
  name: Schema.String,
  artists: Schema.Array(
    Schema.Struct({
      // Null for a name that no evidence links to an artist
      id: Schema.NullOr(Schema.String),
      name: Schema.String,
      // Text after the name, for example ` feat. `. Origins that give only `name` omit it.
      joinPhrase: Schema.optionalKey(Schema.String),
    }),
  ),
});

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
