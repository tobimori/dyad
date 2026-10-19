import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { RowList, albumRows, counted } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Albums";

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

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <>
          <ListTitle
            title={title}
            detail={items.length === 0 ? "" : counted(items.length, "album")}
          />
          <RowList
            rows={items}
            selected={items[list.selected]?.key ?? null}
            playingId={app.player.current?.source.id ?? null}
            empty={empty}
            onSelect={list.selectRow}
            onActivate={list.activateRow}
          />
        </>
      ),
    });
  },
});
