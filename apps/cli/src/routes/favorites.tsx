import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { TrackList, entryItems, playsSource } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Favorites";

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

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <TrackList
          title={title}
          items={items}
          selected={list.selected}
          playing={playsSource(app.player.current?.source.id)}
          historyRows={0}
          markSaved={false}
          empty={
            AsyncResult.isInitial(library)
              ? "Loading the favorites"
              : "No favorites. Press shift+f on a song to add it."
          }
          onSelect={list.select}
          onActivate={list.activate}
        />
      ),
    });
  },
});
