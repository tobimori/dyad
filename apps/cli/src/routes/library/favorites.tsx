import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { useListScreen } from "../../component/list-screen.tsx";
import { TrackList, entryItems, playsSource } from "../../component/track-list.tsx";
import type { TrackItem } from "../../component/track-list.tsx";
import { Section, SectionView } from "../../context/routes.ts";
import { useReload } from "../../context/screen-app.ts";
import type { ScreenApp } from "../../context/screen-app.ts";

const title = "Favorites";

function FavoritesScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<TrackItem>;
  readonly empty: string;
}) {
  const list = useListScreen(props.app, { title, items: props.items });
  return (
    <TrackList
      title={title}
      items={props.items}
      selected={list.selected}
      playing={playsSource(props.app.player.current?.source.id)}
      historyRows={0}
      markSaved={false}
      empty={props.empty}
      onSelect={list.select}
      onActivate={list.activate}
    />
  );
}

export const favorites = new Section({
  id: "favorites",
  title,
  order: 44,
  command: null,
  useView: (app) => {
    const library = useAtomValue(app.atoms.library);
    const refresh = useAtomRefresh(app.atoms.library);

    // Newest first, like a list of likes
    const items = useMemo(
      () =>
        entryItems(
          (AsyncResult.isSuccess(library) ? library.value : [])
            .filter((entry) => entry.favorite)
            .toSorted((a, b) => b.addedAt - a.addedAt),
          "library",
          (entry) => entry.source?.id ?? entry.recordingId,
        ),
      [library],
    );

    const empty = AsyncResult.isInitial(library)
      ? "Loading the favorites"
      : "No favorites. Press shift+f on a song to add it.";
    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => <FavoritesScreen app={app} items={items} empty={empty} />,
    });
  },
});
