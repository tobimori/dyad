import type { HomeGroup, HomePage, HomeShelf } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo } from "react";

import { accountHint, useLibraryStatus } from "../component/library-notice.tsx";
import { useListScreen } from "../component/list-screen.tsx";
import { AlbumRow, RowList, headed, selectableRows, trackRows } from "../component/row-list.tsx";
import type { Row, SelectableRow } from "../component/row-list.tsx";
import { ListTitle } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";
import { useReload } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";
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

function HomeScreen(props: {
  readonly app: ScreenApp;
  readonly rows: ReadonlyArray<Row>;
  readonly items: ReadonlyArray<SelectableRow>;
  /** Shown above the charts until the user played something */
  readonly hint: string | null;
  readonly empty: string;
}) {
  const theme = useTheme();
  const list = useListScreen(props.app, { title, items: props.items });
  return (
    <>
      <ListTitle title={title} detail="" />
      {props.hint !== null && (
        <text fg={theme.muted} paddingX={1} marginBottom={1} flexShrink={0}>
          {props.hint}
        </text>
      )}
      <RowList
        rows={props.rows}
        selected={props.items[list.selected]?.key ?? null}
        playingId={props.app.player.current?.source.id ?? null}
        empty={props.empty}
        onSelect={list.selectRow}
        onActivate={list.activateRow}
      />
    </>
  );
}

export const home = new Section({
  id: "home",
  title,
  order: 0,
  command: null,
  useView: (app) => {
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

    const showsHint = AsyncResult.isSuccess(result) && ownShelves === 0 && rows.length > 0;
    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => (
        <HomeScreen
          app={app}
          rows={rows}
          items={items}
          hint={showsHint ? hint : null}
          empty={empty}
        />
      ),
    });
  },
});
