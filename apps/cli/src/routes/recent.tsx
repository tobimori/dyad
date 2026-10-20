import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { useListScreen } from "../component/list-screen.tsx";
import { TrackList, listItems, playsSource } from "../component/track-list.tsx";
import type { TrackItem } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";
import { useReload } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";

const title = "Recently played";

function RecentScreen(props: {
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
      empty={props.empty}
      onSelect={list.select}
      onActivate={list.activate}
    />
  );
}

export const recent = new Section({
  id: "history",
  title,
  order: 50,
  group: null,
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

    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => <RecentScreen app={app} items={items} empty={empty} />,
    });
  },
});
