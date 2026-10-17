import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { RowList, artistRows, counted } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Artists";

export const artists = new Section({
  id: "artists",
  title,
  order: 30,
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
      onSuccess: () => "No artists. The library has no files with artist tags.",
    });

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <>
          <ListTitle
            title={title}
            detail={items.length === 0 ? "" : counted(items.length, "artist")}
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
