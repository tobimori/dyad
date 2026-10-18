import type { HomePage } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { AlbumRow, RowList, headed, selectableRows, trackRows } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";
import { statusText } from "./page/page-view.tsx";

const title = "Home";

// A provider group without shelves shows its state alone, for example why it cannot load
const homeRows = (page: HomePage) =>
  page.groups
    .flatMap((group) => {
      const groupKey = group.providerName ?? "local";
      const status =
        group.providerName === null ? null : statusText(group.state, group.providerName);
      const shelves = group.shelves.filter(
        (shelf) => shelf.tracks.length > 0 || shelf.albums.length > 0,
      );
      if (shelves.length === 0)
        return status === null ? [] : [{ key: groupKey, label: status, rows: [] }];

      return shelves.map((shelf) => {
        const key = `${groupKey}:${shelf.title}`;
        return {
          key,
          label: status === null ? shelf.title : `${shelf.title} · ${status}`,
          rows: [
            ...trackRows(key, shelf.tracks, "home"),
            ...shelf.albums.map((album) => new AlbumRow({ key: `${key}:${album.ref}`, album })),
          ],
        };
      });
    })
    .flatMap((shelf, index) => headed(shelf.key, shelf.label, index === 0, shelf.rows));

export const home = new Section({
  id: "home",
  title,
  order: 0,
  command: null,
  useView: (app) => {
    const result = useAtomValue(app.atoms.homePage);
    const refresh = useAtomRefresh(app.atoms.homePage);
    // The server records a play when its entry stops being current
    const playing = app.player.current?.id;
    useEffect(() => {
      if (playing !== undefined) refresh();
    }, [playing]);

    // After a failed refresh, for example while the server is down, the last page stays
    const rows = useMemo(
      () => Option.match(AsyncResult.value(result), { onNone: () => [], onSome: homeRows }),
      [result],
    );
    const items = useMemo(() => selectableRows(rows), [rows]);

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading",
      onFailure: () => "Cannot load the home page. Press r to try again.",
      onSuccess: () => "Play something, and your recent albums show here.",
    });

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <>
          <ListTitle title={title} detail="" />
          <RowList
            rows={rows}
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
