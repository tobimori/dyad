import { Schema } from "effect";

/** What a version changes. `parse:v1` assertions store these values, so do not rename them */
export const VersionKind = Schema.Literals([
  "remix",
  "edit",
  "flip",
  "bootleg",
  "mashup",
  "cover",
  "live",
  "acoustic",
  "sped_up",
  "slowed",
  "nightcore",
  "vip",
  "instrumental",
  "acapella",
  "extended",
  "radio_edit",
  "demo",
  "rework",
]);

export class TitleVersion extends Schema.Class<TitleVersion>("TitleVersion")({
  kind: VersionKind,
  /** Names that the title credits, for example the remixer. Empty when it credits nobody */
  by: Schema.Array(Schema.String),
}) {}

export class MashupPart extends Schema.Class<MashupPart>("MashupPart")({
  /** Empty when the title does not say whose song the part is */
  artists: Schema.Array(Schema.String),
  title: Schema.String,
}) {}

/** Names, not identities: an artist ID needs corroboration, see `artistNameKey` */
export class ParsedTitle extends Schema.Class<ParsedTitle>("ParsedTitle")({
  /** Artists of the original. For a mashup, the artists of all parts */
  artists: Schema.Array(Schema.String),
  featured: Schema.Array(Schema.String),
  /** Title of the original, without versions, guests and decorations */
  title: Schema.String,
  /** The version nearest to the original first: `galore (A Remix) (B edit)` gives the remix, then the edit */
  versions: Schema.Array(TitleVersion),
  parts: Schema.Array(MashupPart),
  /** Text that the parser removed and that is not a version, for example `FREE DL` */
  removed: Schema.Array(Schema.String),
  /** A DJ set or mix: a work of its own, not a version of one song */
  set: Schema.Boolean,
  /** Where `artists` came from. `uploader` is a guess, because uploaders are often not the artist */
  artistSource: Schema.Literals(["title", "provider", "uploader", "none"]),
  /** Nothing confirmed the `artist - title` order, so a resolver can also try the reverse order */
  swappable: Schema.Boolean,
  /** `version`: the title credits the uploader for a version. `other`: a reupload, a label or unknown */
  uploaderRole: Schema.Literals(["artist", "version", "other"]),
  confidence: Schema.Finite,
}) {}

/**
 * Key that groups spellings of one name: `A.G. Cook`, `A. G. Cook` and `a.g cook` give `agcook`.
 * Many artists share a name, so a key only proposes candidates and never identifies an artist.
 */
export const artistNameKey = (name: string) =>
  name
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "");

/** Key to compare base titles: `Drugs.` and `drugs` give `drugs` */
export const titleKey = (title: string) =>
  title
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

// Compound phrases come first. Only `maker` kinds take a credit (`X Remix`, not `katy perry sped
// up`). Only `loose` words mark a version without brackets: `Money Flip` is a song title.
const kindWords: ReadonlyArray<{
  kind: typeof VersionKind.Type;
  words: string;
  loose: boolean;
  maker: boolean;
}> = [
  { kind: "bootleg", words: "bootleg(?: re-?mix)?|re-?mix bootleg", loose: true, maker: true },
  { kind: "mashup", words: "mash[ -]?up(?: re-?mix)?|mash", loose: true, maker: true },
  {
    kind: "radio_edit",
    words: "radio (?:edit|mix|version|cut)|single edit",
    loose: true,
    maker: false,
  },
  { kind: "extended", words: "extended(?: mix| version| edit)?", loose: true, maker: true },
  { kind: "vip", words: "vip(?: mix| re-?mix| edit)?", loose: true, maker: true },
  { kind: "nightcore", words: "nightcore", loose: true, maker: false },
  {
    kind: "sped_up",
    words: "(?:sped|speed)[ -]?up(?: re-?mix)?|sped|speed",
    loose: true,
    maker: false,
  },
  {
    kind: "slowed",
    words: "slowed(?: down| mix| re-?mix)?|reverb|low pitch|chopped (?:and|&|n) screwed|screwed",
    loose: true,
    maker: false,
  },
  { kind: "slowed", words: "slow", loose: false, maker: false },
  {
    kind: "instrumental",
    words: "instrumental|inst\\.?|karaoke|off vocal",
    loose: true,
    maker: false,
  },
  { kind: "acapella", words: "a ?capp?ella|acc?app?ella|vocals only", loose: true, maker: true },
  { kind: "flip", words: "flip", loose: false, maker: true },
  { kind: "rework", words: "re-?work(?:ed)?|retwerk|re-?imagined|rerub", loose: true, maker: true },
  {
    kind: "cover",
    words: "(?:acoustic |ai |guitar |piano )?cover(?: version| unplugged)?",
    loose: true,
    maker: true,
  },
  { kind: "demo", words: "demo(?: version)?", loose: true, maker: false },
  { kind: "live", words: "live(?: version| session)?", loose: false, maker: false },
  { kind: "acoustic", words: "acoustic(?: version)?|unplugged", loose: false, maker: false },
  { kind: "remix", words: "re-?mix(?:ed)?|rmx", loose: true, maker: true },
  { kind: "remix", words: "mix|mx", loose: false, maker: true },
  { kind: "edit", words: "re-?edit|edit|edt", loose: true, maker: true },
];

const wordEdge = (source: string) => `(?<![\\p{L}\\p{N}])(?:${source})(?![\\p{L}\\p{N}])`;
const kindPatterns = {
  bracket: new RegExp(kindWords.map((entry) => wordEdge(entry.words)).join("|"), "giu"),
  loose: new RegExp(
    kindWords.flatMap((entry) => (entry.loose ? [wordEdge(entry.words)] : [])).join("|"),
    "giu",
  ),
};
const makerKinds = new Set(kindWords.flatMap((entry) => (entry.maker ? [entry.kind] : [])));
const kindEntry = (phrase: string) =>
  kindWords.find((entry) => new RegExp(`^(?:${entry.words})$`, "iu").test(phrase))!;

// Genre and style words around a credit, for example `Ghoulish UKG Remix` or `Acoustic X Cover`
const qualifierWords = [
  "hard techno",
  "techno",
  "hardstyle",
  "hardtekk",
  "hard",
  "d'?n'?b",
  "drum (?:and|&|n) bass",
  "jersey ?club",
  "jersey",
  "club",
  "amapiano",
  "phonk",
  "(?:deep|tech|afro|future|bass) house",
  "house",
  "uk ?g(?:arage)?",
  "garage",
  "2 ?step",
  "makina",
  "frenchcore",
  "hyperpop",
  "guitar",
  "piano",
  "acoustic",
  "trap",
  "drill",
  "rage",
  "schranz",
  "bossa nova",
  "chill",
  "lo-?fi",
  "special",
  "official",
  "unofficial",
  "unreleased",
  "soft",
  "baile",
  "funk",
  "edm",
  "dubstep",
  "trance",
  "hardcore",
  "breaks",
  "dance",
  "dub",
  "ultra",
  "tiktok",
  "sc",
  "\\d{4}",
].join("|");
const leadingQualifier = new RegExp(`^(?:${qualifierWords})(?:\\s+|$)`, "iu");
const trailingQualifier = new RegExp(`(?:^|\\s+)(?:${qualifierWords}|my|x|&|and|,|-)$`, "iu");

// Text that is not part of the song: promotion, quality, years and producer credits
const decorationWords = [
  "free(?: ?(?:dl|download))?\\^?",
  ".*\\bfree (?:dl|download)\\b.*",
  ".*\\bout now\\b.*",
  "preview",
  "snippet",
  "teaser",
  "clip",
  "(?:full )?unreleased",
  "leak(?:ed)?",
  ".*\\bx?clusive\\b.*",
  "premiere",
  "official(?: (?:audio|video|music video|visuali[sz]er|lyric video))?",
  "lyrics?(?: video)?",
  "letra",
  "hq|hd|320(?: ?kbps)?",
  "explicit|clean|dirty",
  "og(?: ver\\.?| version)?",
  "original(?: mix| version)?",
  "(?:digital )?bonus(?: track)?",
  "tiktok(?: version)?",
  "versi[oó]n|ver\\.?",
  "\\d{4}",
  "v\\d+",
  "pt\\.? ?\\d+|part \\d+",
  "\\d+(?:\\.\\d+)?x",
  "\\d+ ?in ?1",
];
const decoration = new RegExp(`^(?:${decorationWords.join("|")})$`, "iu");
const trailingDecoration = new RegExp(
  `\\s+(?:${decorationWords.filter((words) => !words.startsWith(".*")).join("|")})$`,
  "iu",
);
const noiseWords = new RegExp(
  `^(?:(?:${decorationWords.join("|")}|out|now|final|single|full|new)(?:\\s+|$))+$`,
  "iu",
);
const producer = /^prod(?:\.|uced)?(?: by)?\s+@?(.+)$/iu;
const inlineProducer = /\s[[(]?prod(?:\.|uced)?(?: by)?\s+@?([^)\]]+)[)\]]?$/iu;
const featuring = /^(?:feat\.?|ft\.?|featuring|with|w\/)\s+(.+)$/iu;
const inlineFeaturing = /\s(?:feat\.?|ft\.?|featuring)\s+(.+)$/iu;
const setWords =
  /(?<![\p{L}\p{N}])(?:live set|dj set|full set|dj mix|mixtape|boiler room|essential mix|podcast|live (?:at|@|from)\s)/iu;

// `A - B`, `A – B`, `A ~ B`, `A | B`, `A || B`, `A // B`, `A / B`, `A _ B`, and `A- B`
const separator = /\s+(?:[-–—~|_]|\/\/?|\|\|)\s+|(?<=\S)[-–—]\s+/u;
const nameSeparator = /\s*(?:,|&|\s(?:x|vs\.?|and)\s)\s*/iu;
const brackets = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["【", "】"],
  ["«", "»"],
]);
const trailingGroup = /\s*[([{【«][^()[\]{}【】«»]*[)\]}】»]$/u;

// Top-level bracket groups, by code point index. An unclosed group runs to the end.
const findGroups = (chars: ReadonlyArray<string>) => {
  const groups: Array<{ start: number; end: number }> = [];
  const stack: Array<string> = [];
  for (const [index, char] of chars.entries()) {
    const close = brackets.get(char);
    if (close !== undefined) {
      if (stack.length === 0) groups.push({ start: index, end: chars.length });
      stack.push(close);
    } else if (stack.at(-1) === char) {
      stack.pop();
      if (stack.length === 0) groups.at(-1)!.end = index + 1;
    }
  }
  return groups.map((group) => ({
    ...group,
    inner: chars.slice(group.start + 1, group.end - 1).join(""),
  }));
};

const cleanName = (name: string) =>
  name
    .replace(/\s+aka\s.*$/iu, "")
    .replaceAll(/^[\s"'“”‘’*,&@]+|[\s"'“”‘’*,&]+$/gu, "")
    .trim();

const cleanTitle = (title: string) =>
  title
    .replaceAll(/\s+/gu, " ")
    .replace(/^[\s"'“”‘’*:,-]+|[\s"'“”‘’*:,-]+$/gu, "")
    .trim();

// `Ghoulish UKG` gives `Ghoulish`, `Acoustic RUNAGROUND` gives `RUNAGROUND`
// RETURN TYPE: recursive function
const stripQualifiers = (credit: string): string => {
  const stripped = credit.trim().replace(leadingQualifier, "").replace(trailingQualifier, "");
  if (stripped !== credit.trim()) return stripQualifiers(stripped);
  return /^(?:dj|the|my|a)$/iu.test(stripped) ? "" : stripped;
};

// Adjacent phrases of the same kind join: `slowed + reverb`
const kindRuns = (text: string, loose: boolean) =>
  [...text.matchAll(loose ? kindPatterns.loose : kindPatterns.bracket)].reduce<
    Array<{ start: number; end: number; kind: typeof VersionKind.Type; maker: boolean }>
  >((runs, match) => {
    const entry = kindEntry(match[0]);
    const last = runs.at(-1);
    const end = match.index + match[0].length;
    if (
      last?.kind === entry.kind &&
      /^[\s/+&]*(?:and\s*)?$/iu.test(text.slice(last.end, match.index))
    ) {
      last.end = end;
      return runs;
    }
    runs.push({ start: match.index, end, kind: entry.kind, maker: entry.maker });
    return runs;
  }, []);

// `credit` comes before the kind (`X Remix`) or after it (`Remix by X`, `REMIX X`). `byWord`
// tells that the text said `by`, which matters for covers.
const parseVersions = (text: string, loose: boolean) => {
  const runs = kindRuns(text, loose);
  const removed: Array<string> = [];
  const versions = runs.map((run, index) => {
    const before = text.slice(index === 0 ? 0 : runs[index - 1]!.end, run.start);
    const after = text.slice(run.end, runs[index + 1]?.start ?? text.length).trim();
    const lead = stripQualifiers(before.replace(/^[\s+&,/]*(?:and\s)?/iu, ""));
    const isLast = index === runs.length - 1;
    const byWord = /^(?:by|from)\s/iu.test(after);
    const trailCredit =
      isLast && after !== "" && !noiseWords.test(after) && (byWord || (!loose && lead === ""));
    if (isLast && after !== "" && !trailCredit) removed.push(after);
    const leadCredit = run.maker && !decoration.test(lead) ? lead : "";
    if (lead !== "" && leadCredit === "") removed.push(lead);
    const credit = trailCredit ? after.replace(/^(?:by|from)\s+/iu, "") : leadCredit;
    return { kind: run.kind, credit: cleanName(credit), byWord, position: 0 };
  });
  return { versions, removed, runs };
};

// Marks the place of a bracket group in the title while separators split it
const marker = /\uE000(\d+)\uE000/gu;

/** Parses an upload title such as `a.g. cook - oh yeah (baby rocket remix)`, without I/O */
export const parseVersionTitle = (input: {
  readonly title: string;
  readonly uploader: string | null;
  /** The provider's free-text artist field, for example SoundCloud `publisher_metadata.artist` */
  readonly artists?: ReadonlyArray<string>;
  /**
   * Catalog artists with this `artistNameKey`. One artist orders `title - artist` and keeps
   * `Nova & Jory` whole. A name of several artists, such as `EDEN`, never decides alone.
   */
  readonly artistCount?: (key: string) => number;
}) => {
  const countOf = (name: string) => {
    const key = artistNameKey(name);
    return key === "" ? 0 : (input.artistCount?.(key) ?? 0);
  };
  const uploaderKey = artistNameKey(input.uploader ?? "");
  const splitNames = (names: string) => {
    const whole = cleanName(names);
    if (whole === "") return [];
    if (countOf(whole) > 0) return [whole];
    return whole
      .split(nameSeparator)
      .flatMap((name) => (cleanName(name) === "" ? [] : [cleanName(name)]));
  };
  const removed: Array<string> = [];
  const featured: Array<string> = [];
  const producers: Array<string> = [];
  const providerArtists = (input.artists ?? []).flatMap((artist) => {
    const guests = artist.match(inlineFeaturing);
    if (guests !== null) featured.push(...splitNames(guests[1]!));
    return splitNames(guests === null ? artist : artist.slice(0, guests.index));
  });
  const providerKeys = new Set(providerArtists.map(artistNameKey));
  const isCreditName = (name: string) => {
    const key = artistNameKey(name);
    return key !== "" && (key === uploaderKey || providerKeys.has(key) || countOf(name) === 1);
  };
  // `Spurz 45 sec. anti-skip` is a credit of the uploader `Spurz`, but `Holy Priest & elMefti` is not
  const trimCredit = (credit: string) => {
    const words = credit.split(/\s+/u);
    const length = words.findIndex(
      (_, index) => artistNameKey(words.slice(0, index + 1).join(" ")) === uploaderKey,
    );
    const rest = words.slice(length + 1).join(" ");
    if (uploaderKey === "" || length === -1 || /^(?:&|,|x\s|and\s|vs)/iu.test(rest)) return credit;
    return words.slice(0, length + 1).join(" ");
  };

  const decoded = input.title
    .normalize("NFKC")
    .replace(/\.(?:mp3|wav|flac|m4a)$/iu, "")
    .replace(/^\*\*[^*]+\*\*\s*/u, (match) => (removed.push(match.trim()), ""));
  const underscores = (decoded.match(/_/gu)?.length ?? 0) > 2 && !decoded.includes(" ");
  const title = (underscores ? decoded.replaceAll("_", " ") : decoded)
    .replaceAll(/\p{So}|\${2,}/gu, (match) => (removed.push(match), " "))
    .trim();
  const chars = [...title];
  const groups = findGroups(chars);

  // Versions from bracket groups. `position` is the group start until the segments are known.
  const groupVersions: Array<ReturnType<typeof parseVersions>["versions"][number]> = [];
  // RETURN TYPE: recursive function
  const classify = (inner: string, position: number): "title" | "used" => {
    const text = inner.trim();
    const guests = text.match(featuring);
    if (guests !== null) return (featured.push(...splitNames(guests[1]!)), "used");
    const prod = text.match(producer);
    if (prod !== null) return (producers.push(cleanName(prod[1]!)), removed.push(text), "used");
    if (decoration.test(text)) return (removed.push(text), "used");
    const nested = findGroups([...text]);
    if (nested.length > 0) {
      const outer = [...text]
        .map((char, index) =>
          nested.some((group) => index >= group.start && index < group.end) ? " " : char,
        )
        .join("");
      const result = classify(outer, position);
      for (const group of nested) classify(group.inner, position + 0.5);
      return result;
    }
    const parsed = parseVersions(text, false);
    if (parsed.versions.length === 0) return "title";
    groupVersions.push(...parsed.versions.map((version) => ({ ...version, position })));
    removed.push(...parsed.removed);
    return "used";
  };
  const usedGroups = groups.map((group, index) => {
    const used = classify(group.inner, group.start) === "used";
    // A last group of four or more words, or about the version, is a note: `(this is NOT the final version)`
    const note =
      index === groups.length - 1 &&
      group.end === chars.length &&
      (group.inner.trim().split(/\s+/u).length >= 4 || /\bversion\b/iu.test(group.inner));
    if (!used && (group.start === 0 || note)) removed.push(group.inner.trim());
    return used || group.start === 0 || note;
  });

  // Used groups become markers, so that separators inside brackets do not split the title
  const marked = chars
    .flatMap((char, index) => {
      const group = groups.findIndex(
        (candidate) => index >= candidate.start && index < candidate.end,
      );
      if (group === -1 || !usedGroups[group]) return [char];
      return index === groups[group]!.start ? [` \uE000${index}\uE000 `] : [];
    })
    .join("");
  const versionGroups = new Set(groupVersions.map((version) => Math.floor(version.position)));

  // Positions order versions: 1000 for each segment, plus the offset in the segment
  const groupOrder = new Map<number, number>();
  const tailVersions: typeof groupVersions = [];
  const segments = marked.split(separator).map((raw, index) => {
    const markers = [...raw.matchAll(marker)];
    for (const found of markers) groupOrder.set(Number(found[1]), index * 1000 + found.index);
    // Short text after the last version group is decoration: `Diet Coke (KRANK. Remix) FREE DL`.
    // It can also be one more version: `I Loved You More (Dj Arno Remix) Radio Edit`.
    const lastVersion = markers.findLast((found) => versionGroups.has(Number(found[1])));
    const tailStart =
      lastVersion === undefined ? raw.length : lastVersion.index + lastVersion[0].length;
    const tailText = raw.slice(tailStart).replaceAll(marker, "").trim();
    const headText = raw
      .slice(0, lastVersion?.index ?? raw.length)
      .replaceAll(marker, "")
      .trim();
    const cut = headText !== "" && tailText !== "" && tailText.split(/\s+/u).length <= 8;
    const tail = parseVersions(tailText, true);
    const tailIsVersion =
      tail.runs.length > 0 &&
      tail.versions.every((version) => version.credit === "") &&
      stripQualifiers(tailText.slice(0, tail.runs[0]!.start)) === "";
    const tailProducer = tailText.match(producer);
    if (cut && tailIsVersion) {
      tailVersions.push(
        ...tail.versions.map((version) => ({ ...version, position: index * 1000 + tailStart })),
      );
      removed.push(...tail.removed);
    } else if (cut) {
      removed.push(tailText);
      if (tailProducer !== null) producers.push(cleanName(tailProducer[1]!));
    }
    const text = (cut ? raw.slice(0, lastVersion?.index) : raw).replaceAll(marker, " ");
    return {
      text: cleanTitle(text.replace(/^\s*\d{1,2}[-.]\s*(?=\p{L})/u, "")),
      position: index * 1000,
    };
  });
  const versions = [
    ...groupVersions.map((version) => {
      const start = Math.floor(version.position);
      return {
        ...version,
        position: (groupOrder.get(start) ?? start) + (version.position - start),
      };
    }),
    ...tailVersions,
  ];

  // Removes kind words from the end, one by one: `Lyutiki izzamuzzic remix Slowed`
  // RETURN TYPE: recursive function
  const stripLooseVersions = (text: string, position: number, allowCredit: boolean): string => {
    const withoutNoise = text.replace(
      trailingDecoration,
      (match) => (removed.push(match.trim()), ""),
    );
    const last = kindRuns(withoutNoise, true).at(-1);
    if (last === undefined || last.end !== withoutNoise.length || last.start === 0)
      return withoutNoise;
    const head = withoutNoise.slice(0, last.start).trim();
    const words = head.split(/\s+/u);
    // `East Of Eden Cover` and `Blackbear x EDEN Mashup` do not name a maker
    const creditLength =
      !allowCredit || !last.maker || last.kind === "cover" || last.kind === "mashup"
        ? undefined
        : [3, 2, 1].find(
            (length) => length < words.length && isCreditName(words.slice(-length).join(" ")),
          );
    versions.push({
      kind: last.kind,
      credit: creditLength === undefined ? "" : words.slice(-creditLength).join(" "),
      byWord: false,
      position: position + last.start,
    });
    const rest = stripQualifiers(
      creditLength === undefined ? head : words.slice(0, -creditLength).join(" "),
    );
    return stripLooseVersions(rest.replace(/^the\s+/iu, ""), position, allowCredit);
  };

  const withoutGuests = (text: string, position: number) => {
    const prod = text.match(inlineProducer);
    if (prod !== null) producers.push(cleanName(prod[1]!));
    const withoutProducer = prod === null ? text : text.slice(0, prod.index);
    const guests = withoutProducer.match(inlineFeaturing);
    if (guests === null) return withoutProducer;
    featured.push(...splitNames(stripLooseVersions(guests[1]!, position, false)));
    return withoutProducer.slice(0, guests.index).trim();
  };

  // Segments that name the artist or the title. The others are versions, credits or decoration.
  const core: Array<string> = [];
  const versionSegments = new Set<number>();
  const groupArtists: Array<string> = [];
  for (const [index, segment] of segments.entries()) {
    const prod = segment.text.match(producer);
    if (prod !== null) producers.push(cleanName(prod[1]!));
    if (segment.text === "") continue;
    if (prod !== null || decoration.test(segment.text) || /^[^\p{L}\p{N}]*$/u.test(segment.text)) {
      removed.push(segment.text);
      continue;
    }
    const withoutGroup = segment.text.replace(trailingGroup, "");
    const parsed = parseVersions(withoutGroup, true);
    const firstRun = parsed.runs[0];
    const lastRun = parsed.runs.at(-1);
    const onlyVersion =
      segments.length > 1 &&
      firstRun !== undefined &&
      lastRun !== undefined &&
      parsed.versions.every((version) => version.credit === "" || isCreditName(version.credit)) &&
      noiseWords.test(withoutGroup.slice(lastRun.end).trim() || "new") &&
      (parsed.versions[0]!.credit !== "" ||
        stripQualifiers(withoutGroup.slice(0, firstRun.start)) === "");
    if (onlyVersion) {
      versions.push(
        ...parsed.versions.map((version) => ({ ...version, position: segment.position })),
      );
      removed.push(...parsed.removed);
      if (withoutGroup !== segment.text)
        removed.push(segment.text.slice(withoutGroup.length).trim());
      versionSegments.add(index);
      continue;
    }
    // `Ma Luna - Remix - Dj Radikal`: a short last segment credits the version before it
    const previous = versions.at(-1);
    if (
      index === segments.length - 1 &&
      core.length > 0 &&
      previous?.credit === "" &&
      versionSegments.has(index - 1) &&
      segment.text.split(/\s+/u).length <= 4
    ) {
      previous.credit = segment.text;
      continue;
    }
    const text = withoutGuests(segment.text, segment.position);
    const group = text.match(trailingGroup)?.[0] ?? "";
    const beforeGroup = text.slice(0, text.length - group.length);
    const stripped = stripLooseVersions(beforeGroup, segment.position, true);
    // `BULAN MADU AMAPIANO REMIX (Nike Ardila & Inka Christie)`: a group after a version can name the artists
    const versionBeforeGroup = group !== "" && stripped.length < beforeGroup.length;
    if (versionBeforeGroup) groupArtists.push(group.trim().slice(1, -1));
    const kept = cleanTitle(versionBeforeGroup ? stripped : stripped + group);
    if (kept !== "") core.push(kept);
  }

  const set = setWords.test(title);
  const artistScore = (text: string) => {
    const names = splitNames(text);
    const key = artistNameKey(text);
    const provider =
      providerKeys.has(key) || names.some((name) => providerKeys.has(artistNameKey(name)));
    const unique = countOf(text) === 1 || names.some((name) => countOf(name) === 1);
    return (provider ? 3 : 0) + (key === uploaderKey ? 2 : 0) + (unique ? 2 : 0);
  };

  const fromTitle = (() => {
    const none = { artist: "", title: core[0] ?? "", swappable: false };
    if (set) return { ...none, title: title.replace(/\p{So}/gu, "") };
    const [first = "", second = "", ...rest] = core;
    if (core.length >= 2) {
      removed.push(...rest);
      const firstScore = artistScore(first);
      const secondScore = artistScore(second);
      const reversed = secondScore > firstScore;
      return {
        artist: reversed ? second : first,
        title: reversed ? first : second,
        swappable: firstScore === secondScore,
      };
    }
    const byMatch = first.match(/^(.+?)\s+by\s+(.+)$/iu);
    if (byMatch !== null && isCreditName(byMatch[2]!)) {
      return { artist: byMatch[2]!, title: byMatch[1]!, swappable: false };
    }
    // `Planet Wave House, Kelo, Lenn Kuck   NAWE`, `b2b charli xcx`
    const prefix = [...providerArtists, ...(input.artists ?? []), input.uploader ?? ""].find(
      (name) => name.trim() !== "" && first.toLowerCase().startsWith(`${name.toLowerCase()} `),
    );
    if (prefix !== undefined)
      return { artist: prefix, title: first.slice(prefix.length), swappable: false };
    const words = first.split(/\s+/u);
    const suffix = [3, 2].find(
      (length) => length < words.length && countOf(words.slice(-length).join(" ")) === 1,
    );
    if (suffix !== undefined) {
      return {
        artist: words.slice(-suffix).join(" "),
        title: words.slice(0, -suffix).join(" "),
        swappable: false,
      };
    }
    const weak = first.split(/\s{2,}/u);
    if (weak.length === 2) return { artist: weak[0]!, title: weak[1]!, swappable: true };
    return none;
  })();
  const titleText = cleanTitle(fromTitle.title);

  // Mashup parts: `Idfc x Drugs - Blackbear x EDEN Mashup`, `squid game + do it with it`
  const mashup = versions.find((version) => version.kind === "mashup");
  const partTitles = titleText.split(
    mashup === undefined ? /\s+(?:x|\+)\s+/iu : /\s+(?:x|\+|vs\.?|&)\s+/iu,
  );
  const isMashup = partTitles.length > 1 && partTitles.every((part) => part.trim() !== "");
  if (isMashup && mashup === undefined) {
    versions.push({ kind: "mashup", credit: "", byWord: false, position: -1 });
  }
  // `(EDEN Cover)` names whose song it is, unlike `(Cover by X)`. `(Blackbear & Eden Mashup)` names
  // the artists of the parts, not the maker.
  const creditOfOriginal = versions.find(
    (version) =>
      fromTitle.artist === "" &&
      ((version.kind === "cover" && version.credit !== "" && !version.byWord) ||
        (version === mashup &&
          isMashup &&
          splitNames(version.credit).length === partTitles.length)),
  );
  const credited = versions.flatMap((version) =>
    version === creditOfOriginal ? [] : [artistNameKey(version.credit)],
  );

  const chosen = (() => {
    if (fromTitle.artist !== "") return { text: fromTitle.artist, source: "title" } as const;
    if (creditOfOriginal !== undefined)
      return { text: creditOfOriginal.credit, source: "title" } as const;
    if (set && providerArtists.length === 0)
      return { text: input.uploader ?? "", source: "uploader" } as const;
    if (providerArtists.length > 0)
      return { text: providerArtists.join(", "), source: "provider" } as const;
    if (groupArtists[0] !== undefined) return { text: groupArtists[0], source: "title" } as const;
    // A mashup without named artists is the uploader's own work, not a song of the uploader
    if (!isMashup) return { text: input.uploader ?? "", source: "uploader" } as const;
    return { text: "", source: "none" } as const;
  })();
  if (groupArtists[0] !== undefined && chosen.text !== groupArtists[0])
    removed.push(groupArtists[0]);

  // A remixer in the provider's artist field or in a Bandcamp band name is not an artist of the original
  const featuredKeys = new Set(featured.map(artistNameKey));
  const artists = splitNames(chosen.text).filter(
    (name) =>
      !featuredKeys.has(artistNameKey(name)) &&
      (chosen.source === "title" || !credited.includes(artistNameKey(name))),
  );
  const partArtists = splitNames(chosen.text);
  const parts = isMashup
    ? partTitles.map(
        (part, index) =>
          new MashupPart({
            artists: partArtists.length === partTitles.length ? [partArtists[index]!] : [],
            title: cleanTitle(part),
          }),
      )
    : [];

  // A producer credit (`prod. X`) names the maker of a version that names nobody
  const producerFor = versions.find(
    (version) => version.credit === "" && makerKinds.has(version.kind),
  );
  const creditOf = (version: (typeof versions)[number]) => {
    if (version === creditOfOriginal) return "";
    if (version === producerFor) return producers.at(-1) ?? "";
    return version.credit;
  };
  const finalVersions = versions
    .toSorted((a, b) => a.position - b.position)
    .reduce<Array<TitleVersion>>((result, version) => {
      const credit = creditOf(version);
      const by = splitNames(trimCredit(credit));
      const previous = result.at(-1);
      // `[slowed+reverb]` and `(Remix) [Remix]` are one version
      if (previous?.kind === version.kind && (previous.by.length === 0 || by.length === 0))
        return result;
      result.push(new TitleVersion({ kind: version.kind, by }));
      return result;
    }, []);

  const artistKeys = new Set(artists.map(artistNameKey));
  const versionKeys = new Set(finalVersions.flatMap((version) => version.by.map(artistNameKey)));
  const uploaderIsArtist =
    artistKeys.has(uploaderKey) && (chosen.source !== "uploader" || finalVersions.length === 0);
  const uploaderRole = (() => {
    if (versionKeys.has(uploaderKey)) return "version";
    return uploaderIsArtist ? "artist" : "other";
  })();
  const swappable = fromTitle.swappable && chosen.source === "title";
  const uploaderPenalty = finalVersions.length > 0 ? 0.5 : 0.3;
  const confidence =
    1 -
    (swappable ? 0.2 : 0) -
    (chosen.source === "provider" ? 0.2 : 0) -
    (chosen.source === "uploader" ? uploaderPenalty : 0) -
    (titleText === "" ? 0.5 : 0);

  return new ParsedTitle({
    artists,
    featured: [...new Set(featured)],
    title: titleText || cleanTitle(title),
    versions: finalVersions,
    parts,
    removed: removed.flatMap((text) => (text.trim() === "" ? [] : [text.trim()])),
    set,
    artistSource: artists.length === 0 ? "none" : chosen.source,
    swappable,
    uploaderRole,
    confidence: Math.round(Math.max(0, confidence) * 100) / 100,
  });
};
