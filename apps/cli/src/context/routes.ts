import type { ServerAtoms } from "@dyad/client-runtime";
import type { AlbumRef, ArtistRef } from "@dyad/domain";
import { Data } from "effect";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import type { Action } from "../component/dialog-actions.tsx";
import type { usePlaylistActions } from "../component/dialog-playlists.tsx";
import type { SelectableRow } from "../component/row-list.tsx";
import type { TrackItem } from "../component/track-list.tsx";
import type { usePlayer } from "../playback/use-player.ts";
import type { Command } from "./keymap.ts";
import type { useSearch } from "./use-search.ts";

/** The host renders it only while the section route is on top */
export class SectionView extends Data.Class<{
  /** The rows that the cursor moves over. The sidebar shows their count. */
  readonly items: ReadonlyArray<TrackItem | SelectableRow>;
  readonly render: (list: {
    readonly selected: number;
    readonly select: (index: number) => void;
    readonly activate: (index: number) => void;
    readonly selectRow: (row: SelectableRow) => void;
    readonly activateRow: (row: SelectableRow) => void;
  }) => ReactNode;
  readonly refresh?: () => void;
  /** Plays the track item at `index`. Without it, the list plays from that item. */
  readonly play?: (index: number) => void;
  /** Keys before the common list keys. The handler gets the selected index. */
  readonly keys?: ReadonlyArray<readonly [Command, (selected: number) => void]>;
  /** Actions after the common track actions, for the item at `index` or the current track */
  readonly actions?: (index: number | null) => ReadonlyArray<Action>;
  /** Runs when a key or a click opens the section, but not on `tab` */
  readonly focus?: () => void;
}> {}

/** One entry of the sidebar. The built-ins register in `routes/sections.ts`. */
export class Section extends Data.Class<{
  readonly id: string;
  readonly title: string;
  readonly order: number;
  /** The key that opens the section from anywhere */
  readonly command: Command | null;
  /** A hook. The host calls it for each section on each render, for the counts in the sidebar. */
  readonly useView: (app: {
    readonly atoms: ServerAtoms;
    readonly player: ReturnType<typeof usePlayer>;
    readonly search: ReturnType<typeof useSearch>;
    readonly focusList: () => void;
    readonly playlistActions: ReturnType<typeof usePlaylistActions>;
  }) => SectionView;
}> {}

export class SectionRoute extends Data.TaggedClass("Section")<{
  readonly section: Section;
}> {}

export class ArtistRoute extends Data.TaggedClass("Artist")<{
  readonly ref: ArtistRef;
  /** Shown until the page loads */
  readonly hint: string;
}> {}

export class AlbumRoute extends Data.TaggedClass("Album")<{
  readonly ref: AlbumRef;
  /** Shown until the page loads */
  readonly hint: string;
}> {}

export class PlaylistRoute extends Data.TaggedClass("Playlist")<{
  readonly id: string;
  readonly hint: string;
}> {}

export type PageRoute = ArtistRoute | AlbumRoute | PlaylistRoute;

class Navigation extends Data.Class<{
  readonly stack: readonly [SectionRoute, ...Array<PageRoute>];
  /** Keeps the cursor on its item after back navigation and list changes */
  readonly selections: ReadonlyMap<string, string>;
}> {}

// Refs and IDs of different kinds can have the same text, so the key names the kind
const routeKey = (route: SectionRoute | PageRoute) => {
  if (route instanceof SectionRoute) return route.section.id;
  if (route instanceof ArtistRoute) return `artist:${route.ref}`;
  if (route instanceof AlbumRoute) return `album:${route.ref}`;
  return `playlist:${route.id}`;
};

export function useRoutes(initial: Section) {
  const [navigation, setNavigation] = useState(
    () =>
      new Navigation({ stack: [new SectionRoute({ section: initial })], selections: new Map() }),
  );
  // Keys that repeat fast can come before the next render, so key handlers read the newest state
  const latest = useRef(navigation);

  const update = (next: Navigation) => {
    latest.current = next;
    setNavigation(next);
  };

  const stack = navigation.stack;
  const [root] = stack;
  const route = stack.at(-1) ?? root;

  return {
    route,
    section: root.section,
    canGoBack: stack.length > 1,
    breadcrumb: stack
      .map((entry) => (entry instanceof SectionRoute ? entry.section.title : entry.hint))
      .join("  ›  "),
    selected: () => {
      const current = latest.current.stack.at(-1) ?? latest.current.stack[0];
      return latest.current.selections.get(routeKey(current)) ?? null;
    },
    select: (key: string) => {
      const current = latest.current.stack.at(-1) ?? latest.current.stack[0];
      const selections = new Map(latest.current.selections).set(routeKey(current), key);
      update(new Navigation({ ...latest.current, selections }));
    },
    open: (section: Section) =>
      update(new Navigation({ ...latest.current, stack: [new SectionRoute({ section })] })),
    push: (page: PageRoute) => {
      const [first, ...pages] = latest.current.stack;
      update(new Navigation({ ...latest.current, stack: [first, ...pages, page] }));
    },
    back: () => {
      const [first, ...pages] = latest.current.stack;
      update(new Navigation({ ...latest.current, stack: [first, ...pages.slice(0, -1)] }));
    },
  };
}
