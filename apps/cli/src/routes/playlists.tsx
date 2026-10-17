import { providerName } from "@dyad/client-runtime";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { LibraryNotices, useLibraryStatus } from "../component/library-notice.tsx";
import { PlaylistRow, RowList, counted } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

const title = "Playlists";

export const playlists = new Section({
  id: "playlists",
  title,
  order: 45,
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.playlists);
    const refresh = useAtomRefresh(app.atoms.playlists);
    const status = useLibraryStatus(app.atoms);
    const names = status.names;

    const items = useMemo(
      () =>
        (AsyncResult.isSuccess(result) ? result.value : []).map(
          (playlist) =>
            new PlaylistRow({
              key: playlist.id,
              playlist,
              providerName:
                playlist.provider === null ? null : providerName(names, playlist.provider),
            }),
        ),
      [result, names],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the playlists",
      onFailure: () => "Cannot load the playlists. Press r to try again.",
      onSuccess: () => status.importing ?? "No playlists. Link an account with dyad link.",
    });

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <>
          <ListTitle
            title={title}
            detail={items.length === 0 ? "" : counted(items.length, "playlist")}
          />
          <LibraryNotices notices={status.notices} />
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
