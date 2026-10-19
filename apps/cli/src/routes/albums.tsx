import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { RowList, albumRows, counted } from "../component/row-list.tsx";
import { useListScreen } from "../component/list-screen.tsx";
import type { SelectableRow } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";
import { useReload } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";

const title = "Albums";

function AlbumsScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<SelectableRow>;
  readonly empty: string;
}) {
  const list = useListScreen(props.app, { title, items: props.items });
  const items = props.items;
  return (
    <>
      <ListTitle title={title} detail={items.length === 0 ? "" : counted(items.length, "album")} />
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

export const albums = new Section({
  id: "albums",
  title,
  order: 30,
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.libraryAlbums);
    const refresh = useAtomRefresh(app.atoms.libraryAlbums);
    const items = useMemo(
      () => albumRows(AsyncResult.isSuccess(result) ? result.value : []),
      [result],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the albums",
      onFailure: () => "Cannot load the albums. Press r to try again.",
      onSuccess: () => "No albums in your library yet.",
    });

    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => <AlbumsScreen app={app} items={items} empty={empty} />,
    });
  },
});
