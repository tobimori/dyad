import { AlbumRef, ArtistRef } from "@dyad/domain";
import { Array as Arr, Data, Schema } from "effect";
import { useRef, useState } from "react";

/** A screen of the app. `hint` names the page until it loads. */
export const Route = Schema.TaggedUnion({
  Section: { id: Schema.String },
  Artist: { ref: ArtistRef, hint: Schema.String },
  /** `artistRef` puts the album under the page of its artist */
  Album: { ref: AlbumRef, hint: Schema.String, artistRef: Schema.NullOr(ArtistRef) },
  Playlist: { id: Schema.String, hint: Schema.String },
  NowPlaying: {},
});
export type Route = typeof Route.Type;

/**
 * Where a route is: the sidebar section, then the pages above it. Breadcrumbs show it, and the
 * app opens it again at start.
 */
export class Place extends Schema.Class<Place>("Place")({
  section: Schema.String,
  trail: Schema.NonEmptyArray(Route),
}) {}

// Refs and IDs of different kinds can have the same text, so the key names the kind
const routeKey = (route: Route) =>
  Route.match(route, {
    Section: (section) => `section:${section.id}`,
    Artist: (artist) => `artist:${artist.ref}`,
    Album: (album) => `album:${album.ref}`,
    Playlist: (playlist) => `playlist:${playlist.id}`,
    NowPlaying: () => "now-playing",
  });

export const sectionPlace = (id: string) =>
  new Place({ section: id, trail: [Route.cases.Section.make({ id })] });

// Going deeper adds a level; moving sideways, for example to another artist, replaces the trail
const placeOf = (from: Place, route: Route) => {
  const root = Route.cases.Section.make({ id: from.section });
  const trail = from.trail;
  const last = trail.at(-1);
  const isArtist = (candidate: Route | undefined, ref: ArtistRef | null) =>
    ref !== null && Route.guards.Artist(candidate) && candidate.ref === ref;

  const next = Route.match(route, {
    Section: (section) => Arr.of<Route>(section),
    NowPlaying: (nowPlaying) => Arr.of<Route>(nowPlaying),
    Artist: (artist) => Arr.make<[Route, Route]>(root, artist),
    Playlist: (playlist) => Arr.make<[Route, Route]>(root, playlist),
    Album: (album) => {
      if (isArtist(last, album.artistRef)) return Arr.append(trail, album);
      if (Route.guards.Album(last) && isArtist(trail.at(-2), album.artistRef)) {
        return Arr.append(Arr.initNonEmpty(trail), album);
      }
      return Arr.make<[Route, Route]>(root, album);
    },
  });
  const first = next[0];
  return new Place({
    section: Route.guards.Section(first) ? first.id : from.section,
    trail: next,
  });
};

class History extends Data.Class<{
  readonly places: readonly [Place, ...Array<Place>];
  /** Keeps the cursor on its item after back navigation and list changes */
  readonly selections: ReadonlyMap<string, string>;
}> {}

/** `esc` follows the history; the breadcrumb shows the place */
export function useRouter(initial: Place, onChange: (place: Place) => void) {
  // At start, back goes up the trail, and the now playing screen goes back to its section
  const [history, setHistory] = useState(() => {
    const [first, ...rest] = initial.trail;
    const levels = initial.trail.map(
      (_, index) => new Place({ ...initial, trail: [first, ...rest.slice(0, index)] }),
    );
    const start = Route.guards.Section(initial.trail[0]) ? [] : [sectionPlace(initial.section)];
    const places = Arr.appendAll(start, levels);
    return new History({
      places: Arr.isArrayNonEmpty(places) ? places : [initial],
      selections: new Map(),
    });
  });
  // Keys that repeat fast can come before the next render, so key handlers read the newest state
  const latest = useRef(history);

  const update = (next: History) => {
    const before = latest.current.places.at(-1);
    latest.current = next;
    setHistory(next);
    const place = next.places.at(-1);
    if (place !== undefined && place !== before) onChange(place);
  };
  const current = () => latest.current.places.at(-1) ?? latest.current.places[0];

  const place = history.places.at(-1) ?? history.places[0];
  return {
    route: place.trail.at(-1) ?? place.trail[0],
    place,
    canGoBack: history.places.length > 1,
    selected: () =>
      latest.current.selections.get(routeKey(current().trail.at(-1) ?? current().trail[0])) ?? null,
    select: (key: string) => {
      const route = current().trail.at(-1) ?? current().trail[0];
      const selections = new Map(latest.current.selections).set(routeKey(route), key);
      update(new History({ ...latest.current, selections }));
    },
    /** Starts a new history at the section */
    open: (id: string) => update(new History({ ...latest.current, places: [sectionPlace(id)] })),
    push: (route: Route) => {
      const places = latest.current.places;
      update(new History({ ...latest.current, places: [...places, placeOf(current(), route)] }));
    },
    back: () => {
      const [first, ...rest] = latest.current.places;
      if (rest.length === 0) return;
      update(new History({ ...latest.current, places: [first, ...rest.slice(0, -1)] }));
    },
  };
}
