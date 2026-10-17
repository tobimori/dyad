import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { TrackList, listItems } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Songs";

export const songs = new Section({
  id: "songs",
  title,
  order: 20,
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.sources);
    const refresh = useAtomRefresh(app.atoms.sources);
    const items = useMemo(
      () => listItems(AsyncResult.isSuccess(result) ? result.value : [], "library"),
      [result],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the library",
      onFailure: () => "Cannot load the library. Press r to try again.",
      onSuccess: () => "No files. Set DYAD_LIBRARY_DIR on the server.",
    });

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <TrackList
          title={title}
          items={items}
          selected={list.selected}
          playingKey={app.player.current?.source.id ?? null}
          historyRows={0}
          empty={empty}
          onSelect={list.select}
          onActivate={list.activate}
        />
      ),
    });
  },
});
