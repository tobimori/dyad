import { providerName } from "@dyad/client-runtime";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { LibraryNotices, useLibraryStatus } from "../component/library-notice.tsx";
import { useListScreen } from "../component/list-screen.tsx";
import { PlaylistRow, RowList, counted } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import { Section, SectionView } from "../context/routes.ts";
import { useReload } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";

const title = "Playlists";

function PlaylistsScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<PlaylistRow>;
  readonly notices: Parameters<typeof LibraryNotices>[0]["notices"];
  readonly keys: ReadonlyArray<readonly [Command, (selected: number) => void]>;
  readonly empty: string;
}) {
  const list = useListScreen(props.app, { title, items: props.items, keys: props.keys });
  const items = props.items;
  return (
    <>
      <ListTitle
        title={title}
        detail={items.length === 0 ? "" : counted(items.length, "playlist")}
      />
      <LibraryNotices notices={props.notices} />
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

export const playlists = new Section({
  id: "playlists",
  title,
  order: 40,
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
                playlist.link === null ? null : providerName(names, playlist.link.provider),
            }),
        ),
      [result, names],
    );

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading the playlists",
      onFailure: () => "Cannot load the playlists. Press r to try again.",
      onSuccess: () =>
        status.importing ?? "No playlists. Press c to make one, or link an account with dyad link.",
    });

    const rename = (selected: number) => {
      const row = items[selected];
      if (row === undefined) return;
      app.playlistActions
        .manage(row.playlist, () => {})
        .find((action) => action.command === commands.renamePlaylist)
        ?.run();
    };

    const keys = [
      [commands.newPlaylist, app.playlistActions.create],
      [commands.renamePlaylist, rename],
    ] as const;
    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => (
        <PlaylistsScreen
          app={app}
          items={items}
          notices={status.notices}
          keys={keys}
          empty={empty}
        />
      ),
    });
  },
});
