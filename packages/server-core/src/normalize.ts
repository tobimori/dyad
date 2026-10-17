// Search ranking and grouping use these rules. Recording matching must use the same rules, so that a
// search group and a stored match agree.

const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * Tags and providers can write an ISRC with hyphens or in lowercase, for example
 * `us-rc1-76-07839`. `null` when the value is not a valid ISRC.
 */
export const normalizeIsrc = (isrc: string) => {
  const normalized = isrc.replaceAll("-", "").trim().toUpperCase();
  return isrcPattern.test(normalized) ? normalized : null;
};

// Providers credit guests in the title or in the artist, for example `Song (feat. Guest)` or
// `Song feat. Guest - Remix`
const bracketedFeaturing = /[([]\s*(?:feat|ft|featuring)\b[^)\]]*[)\]]/g;
const trailingFeaturing = /\s(?:feat|ft|featuring)\b.*?(?=\s-\s|[([]|$)/g;

// The first of several credited artists, for example `Daft Punk` of `Daft Punk & Pharrell Williams`
const artistSeparator = /\s*(?:,|&|\bx\b|\bwith\b|\bfeat\b|\bft\b|\bfeaturing\b)\s*/;

/** Lowercase words without diacritics and punctuation, separated by one space */
export const simplifyText = (text: string) =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll("&", " and ")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/** `simplifyText` without `feat.` parts */
export const normalizeText = (text: string) => {
  const withoutGuests = text
    .toLowerCase()
    .replaceAll(bracketedFeaturing, " ")
    .replaceAll(trailingFeaturing, "");
  return simplifyText(withoutGuests);
};

/** Without version parts such as `(Remastered 2011)` or `- Single Version` */
export const normalizeTitle = (title: string) => {
  const withoutVersion = title.replaceAll(/[([][^)\]]*[)\]]/g, " ").replace(/\s-\s.*$/, "");
  return normalizeText(withoutVersion);
};

/** The first credited artist, normalized */
export const normalizeArtist = (artist: string) =>
  normalizeText(artist.toLowerCase().split(artistSeparator)[0] ?? "");
