import type { catalogAssertion } from "@dyad/db";
import { PartialDate, ReleaseType, SecondaryType } from "@dyad/domain";
import { Option, Schema } from "effect";

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

type Assertion = typeof catalogAssertion.$inferSelect;

// An album before an EP and a single, then compilations, live releases and sessions. An unknown
// type counts as an album.
const typeRank = (type: typeof AlbumType.Type | undefined) => {
  if (type?.secondary.some((secondary) => secondary === "compilation" || secondary === "live")) {
    return 3;
  }
  if (type?.primary === "ep") return 1;
  if (type?.primary === "single") return 2;
  return 0;
};

/**
 * The album that a merged recording shows, with the artwork of the same origin: an album before an
 * EP and a single, then the original edition before a deluxe edition, then the better origin as in
 * `compare`, then the earlier release. A bonus track is only on its edition, so it keeps that one.
 * `undefined` when an admin set the album, or when no origin has one.
 */
export const shownAlbum = (
  assertions: ReadonlyArray<Assertion>,
  compare: (a: Assertion, b: Assertion) => number,
) => {
  const admin = (field: string) =>
    assertions.some((assertion) => assertion.field === field && assertion.origin === "admin");
  if (admin("album")) return undefined;

  const sameOrigin = (field: string, album: Assertion) =>
    assertions.find(
      (other) =>
        other.field === field &&
        other.origin === album.origin &&
        other.originRef === album.originRef,
    )?.value;
  const candidates = assertions.flatMap((assertion) => {
    if (assertion.field !== "album" || assertion.origin === "admin") return [];
    const name = Schema.decodeUnknownOption(Schema.String)(assertion.value);
    if (Option.isNone(name)) return [];
    return [
      {
        assertion,
        name: name.value,
        type: Option.getOrUndefined(
          Schema.decodeUnknownOption(AlbumType)(sameOrigin("album_type", assertion)),
        ),
        date: Option.getOrNull(
          Schema.decodeUnknownOption(ReleaseDate)(sameOrigin("release_date", assertion)),
        ),
      },
    ];
  });

  // Another edition adds a suffix or more text after a separator, for example `Album / Remixes`
  const names = candidates.map((candidate) => candidate.name);
  const isEdition = (name: string) =>
    editionBase(name) !== name ||
    names.some(
      (other) =>
        other.length < name.length &&
        name.startsWith(other) &&
        /^\s*[/:([\-–]/.test(name.slice(other.length)),
    );
  const rank = (candidate: (typeof candidates)[number]) =>
    typeRank(candidate.type) * 2 + Number(isEdition(candidate.name));

  const bestRank = Math.min(...candidates.map(rank));
  const ranked = candidates
    .filter((candidate) => rank(candidate) === bestRank)
    .toSorted((a, b) => compare(a.assertion, b.assertion));
  const origin = ranked[0]?.assertion.origin;
  // Unknown dates last; a partial date sorts before the full dates of its year
  const [shown] = ranked
    .filter((candidate) => candidate.assertion.origin === origin)
    .toSorted(
      (a, b) =>
        Number(a.date === null) - Number(b.date === null) ||
        (a.date ?? "").localeCompare(b.date ?? "") ||
        compare(a.assertion, b.assertion),
    );
  if (shown === undefined) return undefined;

  const artwork = admin("artwork_url")
    ? Option.none()
    : Schema.decodeUnknownOption(Schema.String)(sameOrigin("artwork_url", shown.assertion));
  return { album: shown.name, artworkUrl: Option.getOrNull(artwork) };
};
