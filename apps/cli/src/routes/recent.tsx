import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { TrackList, listItems } from "../component/track-list.tsx";
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
