import { titleOf } from "@dyad/client-runtime";
import type { SetSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import type { Action } from "../../component/dialog-actions.tsx";
import { useListScreen } from "../../component/list-screen.tsx";
import { ListItem, TrackList, playsSource } from "../../component/track-list.tsx";
import { Section, SectionView } from "../../context/routes.ts";
import { useReload } from "../../context/screen-app.ts";
import type { ScreenApp } from "../../context/screen-app.ts";

const title = "Sets";

const tracklistLine = (set: SetSummary) => `${set.identified.length}/${set.tracks} identified`;

function SetsScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<ListItem>;
  readonly songActions: (index: number | null) => ReadonlyArray<Action>;
  readonly empty: string;
}) {
  const list = useListScreen(props.app, {
    title,
    items: props.items,
    songActions: props.songActions,
  });
  return (
    <TrackList
      title={title}
      noun="set"
      items={props.items}
      selected={list.selected}
      playing={playsSource(props.app.player.current?.source.id)}
      historyRows={0}
      empty={props.empty}
      onSelect={list.select}
      onActivate={list.activate}
    />
  );
}

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

    const songActions = (index: number | null) => {
      const set = index === null ? undefined : list[index];
      if (set === undefined || set.identified.length === 0) return [];
      return [app.playlistActions.saveSet(titleOf(set.source), set.identified)];
    };
    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => <SetsScreen app={app} items={items} songActions={songActions} empty={empty} />,
    });
  },
});
