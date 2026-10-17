import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { TrackList, listItems, playsSource } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Recently played";

export const recent = new Section({
  id: "history",
  title,
  order: 50,
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.recentPlays);
    const refresh = useAtomRefresh(app.atoms.recentPlays);
    const items = useMemo(
      () => listItems(AsyncResult.isSuccess(result) ? result.value : [], "history"),
      [result],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the plays",
      onFailure: () => "Cannot load the plays. Press r to try again.",
      onSuccess: () => "No plays yet",
    });

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
          empty={empty}
          onSelect={list.select}
          onActivate={list.activate}
        />
      ),
    });
  },
});
