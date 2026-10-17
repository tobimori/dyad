import type { AlbumRef, ArtistRef } from "@dyad/domain";
import { Data } from "effect";
import { useRef, useState } from "react";

export const sections = [
  { id: "search", label: "Search" },
  { id: "songs", label: "Songs" },
  { id: "artists", label: "Artists" },
  { id: "albums", label: "Albums" },
  { id: "history", label: "Recently played" },
  { id: "queue", label: "Queue" },
] as const;

export type SectionId = (typeof sections)[number]["id"];

export class SectionRoute extends Data.TaggedClass("Section")<{
  readonly section: SectionId;
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

export type PageRoute = ArtistRoute | AlbumRoute;

class Navigation extends Data.Class<{
  readonly stack: readonly [SectionRoute, ...Array<PageRoute>];
  /** Keeps the cursor on its item after back navigation and list changes */
  readonly selections: ReadonlyMap<string, string>;
}> {}

// Artist and album refs can have the same text, so the key names the kind
const routeKey = (route: SectionRoute | PageRoute) => {
  if (route instanceof SectionRoute) return route.section;
  if (route instanceof ArtistRoute) return `artist:${route.ref}`;
  return `album:${route.ref}`;
};

export const sectionLabel = (id: SectionId) =>
  sections.find((section) => section.id === id)?.label ?? "";

export function useRoutes(initial: SectionId) {
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
      .map((entry) => (entry instanceof SectionRoute ? sectionLabel(entry.section) : entry.hint))
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
    open: (section: SectionId) =>
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
