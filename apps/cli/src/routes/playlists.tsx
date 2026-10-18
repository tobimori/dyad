import { providerName } from "@dyad/client-runtime";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { LibraryNotices, useLibraryStatus } from "../component/library-notice.tsx";
import { PlaylistRow, RowList, counted } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { commands } from "../context/keymap.ts";
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

    const syncing = status.progress?.playlists ?? false;
    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the playlists",
      onFailure: () => "Cannot load the playlists. Press r to try again.",
      onSuccess: () =>
        syncing
          ? "Syncing the playlists…"
          : (status.importing ??
            "No playlists. Press c to make one, or link an account with dyad link."),
    });

    const rename = (selected: number) => {
      const row = items[selected];
      if (row === undefined) return;
      app.playlistActions
        .manage(row.playlist, () => {})
        .find((action) => action.command === commands.renamePlaylist)
        ?.run();
    };

    return new SectionView({
      items,
      refresh,
      keys: [
        [commands.newPlaylist, app.playlistActions.create],
        [commands.renamePlaylist, rename],
      ],
      render: (list) => (
        <>
          <ListTitle
            title={title}
            detail={items.length === 0 ? "" : counted(items.length, "playlist")}
          />
          <LibraryNotices notices={status.notices} syncing={syncing} />
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
