import type { AlbumCard } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { RowList, albumRows, counted } from "../../component/row-list.tsx";
import { useListScreen } from "../../component/list-screen.tsx";
import type { SelectableRow } from "../../component/row-list.tsx";
import { ListTitle } from "../../component/track-list.tsx";
import { Section, SectionView } from "../../context/routes.ts";
import { useReload } from "../../context/screen-app.ts";
import type { ScreenApp } from "../../context/screen-app.ts";

function AlbumsScreen(props: {
  readonly app: ScreenApp;
  readonly title: string;
  readonly noun: string;
  readonly items: ReadonlyArray<SelectableRow>;
  readonly empty: string;
}) {
  const list = useListScreen(props.app, { title: props.title, items: props.items });
  const items = props.items;
  return (
    <>
      <ListTitle
        title={props.title}
        detail={items.length === 0 ? "" : counted(items.length, props.noun)}
      />
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

const isSingle = (album: AlbumCard) => album.primaryType === "single" || album.primaryType === "ep";

// The saved albums of one kind, from the same list
const albumSection = (options: {
  readonly id: string;
  readonly title: string;
  readonly order: number;
  readonly noun: string;
  readonly keep: (album: AlbumCard) => boolean;
}) =>
  new Section({
    id: options.id,
    title: options.title,
    order: options.order,
    group: "Library",
    command: null,
    useView: (app) => {
      const result = useAtomValue(app.atoms.libraryAlbums);
      const refresh = useAtomRefresh(app.atoms.libraryAlbums);
      const items = useMemo(
        () => albumRows((AsyncResult.isSuccess(result) ? result.value : []).filter(options.keep)),
        [result],
      );
      const plural = options.title.toLowerCase();

      const empty = AsyncResult.match(result, {
        onInitial: () => `Loading the ${plural}`,
        onFailure: () => `Cannot load the ${plural}. Press r to try again.`,
        onSuccess: () => `No ${plural} in your library yet.`,
      });

      useReload(app, refresh);
      return new SectionView({
        count: items.length,
        render: () => (
          <AlbumsScreen
            app={app}
            title={options.title}
            noun={options.noun}
            items={items}
            empty={empty}
          />
        ),
      });
    },
  });

export const albums = albumSection({
  id: "albums",
  title: "Albums",
  order: 30,
  noun: "album",
  keep: (album) => !isSingle(album),
});

export const singles = albumSection({
  id: "singles",
  title: "Singles & EPs",
  order: 32,
  noun: "single",
  keep: isSingle,
});
