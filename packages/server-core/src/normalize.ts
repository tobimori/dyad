const isrcPattern = /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/;

/**
 * Tags and providers can write an ISRC with hyphens or in lowercase, for example
 * `us-rc1-76-07839`. `null` when the value is not a valid ISRC.
 */
export const normalizeIsrc = (isrc: string) => {
  const normalized = isrc.replaceAll("-", "").trim().toUpperCase();
  return isrcPattern.test(normalized) ? normalized : null;
};

// Providers credit guests in the title or in the artist, for example `Song (feat. Guest)`,
// `Song (with Guest)` or `Song feat. Guest - Remix`
const bracketedFeaturing = /[([]\s*(?:(?:feat|ft|featuring|with)\b|w\/)[^)\]]*[)\]]/g;
const trailingFeaturing = /\s(?:(?:feat|ft|featuring)\b|w\/).*?(?=\s-\s|[([]|$)/g;

// The first of several credited artists, for example `Daft Punk` of `Daft Punk & Pharrell Williams`
const artistSeparator =
  /\s*(?:,|&|\+|×|\bx\b|\bvs\b\.?|\bb2b\b|\bwith\b|\bw\/|\bfeat\b|\bft\b|\bfeaturing\b)\s*/;

/** Lowercase words without diacritics and punctuation, separated by one space */
export const simplifyText = (text: string) =>
  text
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    // `Ständer`, `Staender` and `Stander` are one title
    .replaceAll(/([aou])e/gu, "$1")
    .replaceAll("ß", "ss")
    .replaceAll("&", " and ")
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

/**
 * `simplifyText` without `feat.` parts. Recording matching must use the same rules as search, so
 * that a search group and a stored match agree.
 */
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

export const normalizeArtist = (artist: string) =>
  normalizeText(artist.toLowerCase().split(artistSeparator)[0] ?? "");

/**
 * The frozen `norm_v1` of binding: a change needs a new name and a migration of the stored keys.
 * `toLowerCase` is the case fold, because JavaScript has no full case folding.
 */
export const normV1 = (text: string) =>
  text.normalize("NFKC").toLowerCase().trim().replaceAll(/\s+/gu, " ");

/** The title without guests: `Say It (feat. Tove Lo) [Remixes]` gives `Say It [Remixes]` */
export const withoutGuests = (title: string) =>
  title
    .replaceAll(/[([]\s*(?:feat|ft|featuring)\.?\s[^)\]]*[)\]]/giu, "")
    .replace(/\s(?:feat|ft|featuring)\.?\s[^([]*/iu, " ");
