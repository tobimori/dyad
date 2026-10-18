import type { HomeGroup, HomePage, HomeShelf } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { accountHint, useLibraryStatus } from "../component/library-notice.tsx";
import { AlbumRow, RowList, headed, selectableRows, trackRows } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";
import { useTheme } from "../theme/theme.ts";
import { statusText } from "./page/page-view.tsx";

const title = "Home";

const shelvesOf = (group: HomeGroup) =>
  group.shelves.filter((shelf) => shelf.tracks.length > 0 || shelf.albums.length > 0);

const shelfRows = (key: string, shelf: HomeShelf) => [
  ...trackRows(key, shelf.tracks, "home"),
  ...shelf.albums.map((album) => new AlbumRow({ key: `${key}:${album.ref}`, album })),
];

// By intent: the suggestions, the user's own plays, then the charts of all providers under one
// heading with the provider as a detail. A provider group without shelves shows its state alone.
const homeRows = (page: HomePage) => {
  const own = page.groups.filter((group) => group.providerName === null);
  const local = own.filter((group) => group.state.status === "local").flatMap(shelvesOf);
  const suggested = own.filter((group) => group.state.status !== "local").flatMap(shelvesOf);
  const shelves = [
    ...suggested.filter((shelf) => shelf.tracks.length > 0),
    ...local,
    ...suggested.filter((shelf) => shelf.tracks.length === 0),
  ];
  // Two recommenders can give shelves with the same title
  const ownRows = shelves.flatMap((shelf, index) => {
    const key = `${index}:${shelf.title}`;
    return headed(key, shelf.title, index === 0, shelfRows(key, shelf));
  });

  const charts = page.groups.flatMap((group) => {
    const provider = group.providerName;
    if (provider === null) return [];
    const status = statusText(group.state, provider);
    const found = shelvesOf(group);
    if (found.length === 0) return [{ key: provider, label: provider, detail: status, rows: [] }];
    return found.map((shelf) => {
      const key = `${provider}:${shelf.title}`;
      return { key, label: shelf.title, detail: status, rows: shelfRows(key, shelf) };
    });
  });
  if (charts.length === 0) return ownRows;

  return [
    ...ownRows,
    ...headed("charts", "Charts", ownRows.length === 0, []),
    ...charts.flatMap((chart, index) =>
      headed(chart.key, chart.label, index === 0, chart.rows, {
        detail: chart.detail,
        minor: true,
      }),
    ),
  ];
};

export const home = new Section({
  id: "home",
  title,
  order: 0,
  command: null,
  useView: (app) => {
    const theme = useTheme();
    const result = useAtomValue(app.atoms.homePage);
    const status = useLibraryStatus(app.atoms);
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
    // The charts can fill the page before the user played anything
    const ownShelves = Option.match(AsyncResult.value(result), {
      onNone: () => 0,
      onSome: (page) =>
        page.groups.filter((group) => group.providerName === null).flatMap(shelvesOf).length,
    });
    const hint = `Play something, and your recent albums show here. ${accountHint(status.accounts)}`;

    const empty = AsyncResult.match(result, {
      onInitial: () => "Loading",
      onFailure: () => "Cannot load the home page. Press r to try again.",
      onSuccess: () => hint,
    });

    return new SectionView({
      items,
      refresh,
      render: (list) => (
        <>
          <ListTitle title={title} detail="" />
          {AsyncResult.isSuccess(result) && ownShelves === 0 && rows.length > 0 && (
            <text fg={theme.muted} paddingX={1} marginBottom={1} flexShrink={0}>
              {hint}
            </text>
          )}
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
