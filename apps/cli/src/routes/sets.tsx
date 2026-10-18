import { titleOf } from "@dyad/client-runtime";
import type { LocalSet } from "@dyad/client-runtime";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { ListItem, TrackList, playsSource } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Sets";

const tracklistLine = (set: LocalSet) => `${set.identified.length}/${set.tracks} identified`;

export const sets = new Section({
  id: "sets",
  title,
  order: 42,
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.sets);
    const refresh = useAtomRefresh(app.atoms.sets);
    const list = useMemo(() => (AsyncResult.isSuccess(result) ? result.value : []), [result]);
    const items = useMemo(
      () =>
        list.map(
          (set) =>
            new ListItem({
              key: set.source.id,
              source: set.source,
              context: "library",
              reason: tracklistLine(set),
            }),
        ),
      [list],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the sets",
      onFailure: () => "Cannot load the sets. Press r to try again.",
      onSuccess: () => "Play a DJ set with a tracklist, and it shows here.",
    });

    return new SectionView({
      items,
      refresh,
      actions: (index) => {
        const set = index === null ? undefined : list[index];
        if (set === undefined || set.identified.length === 0) return [];
        return [app.playlistActions.saveSet(titleOf(set.source), set.identified)];
      },
      render: (view) => (
        <TrackList
          title={title}
          noun="set"
          items={items}
          selected={view.selected}
          playing={playsSource(app.player.current?.source.id)}
          historyRows={0}
          empty={empty}
          onSelect={view.select}
          onActivate={view.activate}
        />
      ),
    });
  },
});
