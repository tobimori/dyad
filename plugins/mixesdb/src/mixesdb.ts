import { ProviderError, ProviderTracklist, TracklistEntry } from "@dyad/plugin";
import { getJson, HttpStatusError } from "@dyad/plugin/http";
import type { HttpRequestError, makePacer } from "@dyad/plugin/http";
import { clockMs, eventWords, tracklistEntry } from "@dyad/plugin/tracklist";
import { Effect, Schema } from "effect";
import { HttpClientRequest } from "effect/http";

const api = "https://www.mixesdb.com/w/api.php";
// MediaWiki asks bots for a contact in the `User-Agent`
const userAgent = "Dyad/0.0.0 ( https://github.com/tobimori/dyad )";

// An API error has another body, so it fails the decode
const Search = Schema.Struct({
  query: Schema.Struct({ search: Schema.Array(Schema.Struct({ title: Schema.String })) }),
});

const Pages = Schema.Struct({
  query: Schema.Struct({
    pages: Schema.Array(
      Schema.Struct({
        pageid: Schema.Int,
        title: Schema.String,
        revisions: Schema.Array(
          Schema.Struct({
            slots: Schema.Struct({ main: Schema.Struct({ content: Schema.String }) }),
          }),
        ),
      }),
    ),
  }),
});

// Search results that one request reads
const pageLimit = 5;
// Fewer named tracks are rarely worth a tracklist
const minimumTracks = 3;
// A page names the file of its tracklist by the duration
const durationTolerance = 0.03;
// Start times fit only the same file, which can be a few seconds longer or shorter
const timedToleranceMs = 10_000;

// `2016-05-01 - Disclosure @ Boiler Room Shanghai`, `201X - Four Tet - Essential Mix`
const pageTitle = /^[\dX]{4}(?:-[\dX]{2}){0,2} - (.+?)(?: @ | - |$)/;
const nameSeparator = /\s*(?:,|&|\s(?:x|\u00d7|vs\.?|b2b|\+)\s)\s*/iu;
// `[05]`, `[105]`, `[61:20]`, `[1:45:50]`, and `[??]` or `[03?]` for an unknown time
const cue = /^\[([\d?:]+)\]\s*/;

const nameKey = (name: string) =>
  name
    .normalize("NFKD")
    .replaceAll(/\p{M}/gu, "")
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N}]+/gu, "");

const nameKeys = (names: ReadonlyArray<string>) =>
  new Set(names.flatMap((name) => name.split(nameSeparator)).map(nameKey));

const pageArtists = (title: string) => {
  const [, artists] = title.match(pageTitle) ?? [];
  // `Four Tet (Live PA)`
  return nameKeys([artists?.replaceAll(/\s*\([^)]*\)/g, "") ?? ""]);
};

const sameArtists = (set: ReadonlyArray<string>, title: string) => {
  const keys = nameKeys(set);
  const page = pageArtists(title);
  return keys.size === page.size && [...keys].every((key) => page.has(key));
};

const section = (wikitext: string, name: string) => {
  const start = wikitext.search(new RegExp(`^==\\s*${name}\\s*==\\s*$`, "im"));
  if (start === -1) return "";
  const rest = wikitext.slice(start).replace(/^.*\n?/, "");
  const end = rest.search(/^==[^=]|^\[\[Category:/m);
  return end === -1 ? rest : rest.slice(0, end);
};

// `{{StandardShow2h}}` gives the slot of a radio show, not the length of the file
const pageDuration = (wikitext: string) => {
  const details = section(wikitext, "File details");
  const [, clock] = details.match(/^\|\s*(\d{1,2}:\d{2}(?::\d{2})?)\s*$/m) ?? [];
  if (clock !== undefined) return { ms: clockMs(clock), exact: true };
  const [, hours] = details.match(/\{\{StandardShow(\d)h\}\}/) ?? [];
  return hours === undefined ? null : { ms: Number(hours) * 60 * 60 * 1000, exact: false };
};

const cueMs = (time: string | undefined) => {
  if (time === undefined || time.includes("?")) return null;
  // A cue without a colon counts minutes
  return time.includes(":") ? clockMs(time) : Number(time) * 60 * 1000;
};

// The `Tracklist` section in the MixesDB format, `# [12] Artist - Title (Remix) [Label - Cat]`
const parseTracklist = (wikitext: string) =>
  section(wikitext, "Tracklist")
    .replaceAll(/<!--[\s\S]*?-->/g, "")
    // Struck tracks are not in the file of the page
    .replaceAll(/<(s|strike|del)>[\s\S]*?<\/\1>/gi, "")
    .replaceAll(/<br\s*\/?>/gi, "\n")
    .replaceAll(/<\/?[a-z][^>]*>/gi, "")
    .replaceAll(/\{\{[^{}]*\}\}/g, "")
    .replaceAll(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1")
    .replaceAll(/'{2,}/g, "")
    .split("\n")
    .flatMap((raw) => {
      const line = raw.replace(/^[#*:]+\s*/, "").trim();
      // `;Part 1` names a part, `...` is a gap, and links credit the source of the list
      if (line.startsWith(";") || line.startsWith("...") || /https?:\/\//.test(line)) return [];

      const [, time] = line.match(cue) ?? [];
      const text = line
        .replace(cue, "")
        // `01 Artist - Title` in a `<list>`, and `+ Artist - Title` for a track on top of another
        .replace(/^0\d\s+/, "")
        .replace(/^\+\s*/, "")
        .replaceAll(/\s*\[[^\]]*\]/g, "");
      const entry = tracklistEntry(text, cueMs(time));
      return entry === undefined ? [] : [entry];
    });

const toProviderError = (error: HttpStatusError | HttpRequestError) =>
  new ProviderError({
    reason:
      error instanceof HttpStatusError ? `MixesDB answered status ${error.status}` : error.reason,
  });

const request = <S extends Schema.Constraint>(
  pace: Effect.Success<ReturnType<typeof makePacer>>,
  params: Record<string, string>,
  schema: S,
) =>
  pace(
    getJson(
      HttpClientRequest.get(api).pipe(
        HttpClientRequest.setUrlParams({
          format: "json",
          formatversion: "2",
          maxlag: "5",
          ...params,
        }),
        HttpClientRequest.setHeader("User-Agent", userAgent),
      ),
      schema,
    ),
  ).pipe(Effect.mapError(toProviderError));

/**
 * The tracklist of the one mix page whose DJs are the set's artists, whose title and categories
 * name the event, and whose file has the duration of the set
 */
export const setTracklists = (
  pace: Effect.Success<ReturnType<typeof makePacer>>,
  set: {
    readonly artists: ReadonlyArray<string>;
    readonly title: string;
    readonly durationMs: number | null;
  },
) =>
  Effect.gen(function* () {
    const words = eventWords(set.title, set.artists);
    if (set.artists.length === 0 || words.length === 0) return [];

    const search = (searchWords: ReadonlyArray<string>) =>
      request(
        pace,
        {
          action: "query",
          list: "search",
          srsearch: [...set.artists, ...searchWords].join(" "),
          srlimit: "10",
          srprop: "",
        },
        Search,
      ).pipe(
        Effect.map((found) =>
          found.query.search
            .map((result) => result.title)
            .filter((title) => sameArtists(set.artists, title))
            .slice(0, pageLimit),
        ),
      );
    // The search finds only pages with all words, so it tries again without lowercase words such
    // as `above` in `Ben Böhmer live above Cappadocia in Turkey for Cercle`
    const named = eventWords(
      set.title
        .split(/\s+/)
        .filter((word) => !/^\p{Ll}/u.test(word))
        .join(" "),
      set.artists,
    );
    const first = yield* search(words);
    const titles =
      first.length > 0 || named.length === 0 || named.length === words.length
        ? first
        : yield* search(named);
    if (titles.length === 0) return [];

    const pages = yield* request(
      pace,
      {
        action: "query",
        prop: "revisions",
        rvprop: "content",
        rvslots: "main",
        titles: titles.join("|"),
      },
      Pages,
    );

    const matches = pages.query.pages.flatMap((page) => {
      const wikitext = page.revisions[0]?.slots.main.content ?? "";
      const categories = [...wikitext.matchAll(/\[\[Category:([^\]|]+)/g)].map((match) => match[1]);
      const pageWords = new Set(eventWords([page.title, ...categories].join(" "), []));
      const shared = words.filter((word) => pageWords.has(word));
      // A year tells two sets of one event apart
      const years = words.filter((word) => /^(?:19|20)\d\d$/.test(word));
      if (shared.length * 2 < words.length || years.some((year) => !pageWords.has(year))) return [];

      const duration = pageDuration(wikitext);
      const offMs =
        duration === null || set.durationMs === null
          ? null
          : Math.abs(duration.ms - set.durationMs);
      if (offMs !== null && offMs > durationTolerance * (set.durationMs ?? 0)) return [];

      const entries = parseTracklist(wikitext);
      if (entries.filter((entry) => entry.artist !== null).length < minimumTracks) return [];
      return [{ page, entries, offMs, exact: duration?.exact === true }];
    });

    // Two pages that fit without a duration to tell them apart are not a match
    const [best, second] = matches.toSorted(
      (a, b) => (a.offMs ?? Infinity) - (b.offMs ?? Infinity),
    );
    if (best === undefined || (second !== undefined && best.offMs === null)) return [];

    const timed =
      best.exact &&
      best.offMs !== null &&
      best.offMs <= timedToleranceMs &&
      best.entries.filter((entry) => entry.startMs !== null).length >= minimumTracks;
    return [
      new ProviderTracklist({
        part: `${best.page.pageid}#tracklist`,
        entries: timed
          ? best.entries
          : best.entries.map(
              (entry) =>
                new TracklistEntry({ startMs: null, artist: entry.artist, title: entry.title }),
            ),
        confidence: timed ? 0.7 : 0.5,
      }),
    ];
  });
