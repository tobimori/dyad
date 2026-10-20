import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { RowList, artistRows, counted } from "../../component/row-list.tsx";
import { useListScreen } from "../../component/list-screen.tsx";
import type { SelectableRow } from "../../component/row-list.tsx";
import { ListTitle } from "../../component/track-list.tsx";
import { Section, SectionView } from "../../context/routes.ts";
import { useReload } from "../../context/screen-app.ts";
import type { ScreenApp } from "../../context/screen-app.ts";

const title = "Artists";

function ArtistsScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<SelectableRow>;
  readonly empty: string;
}) {
  const list = useListScreen(props.app, { title, items: props.items });
  const items = props.items;
  return (
    <>
      <ListTitle title={title} detail={items.length === 0 ? "" : counted(items.length, "artist")} />
      <RowList
        rows={items}
        selected={items[list.selected]?.key ?? null}
        playingId={props.app.player.current?.source.id ?? null}
        empty={props.empty}
        onSelect={list.selectRow}
        onActivate={list.activateRow}
      />
    </>
  );
}

export const artists = new Section({
  id: "artists",
  title,
  order: 35,
  group: "Library",
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.libraryArtists);
    const refresh = useAtomRefresh(app.atoms.libraryArtists);
    const items = useMemo(
      () => artistRows(AsyncResult.isSuccess(result) ? result.value : []),
      [result],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the artists",
      onFailure: () => "Cannot load the artists. Press r to try again.",
      onSuccess: () => "No artists in your library yet.",
    });

    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => <ArtistsScreen app={app} items={items} empty={empty} />,
    });
  },
});
