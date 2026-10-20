import type { DownloadPin, ServerAtoms } from "@dyad/client-runtime";
import { AlbumPage, ArtistPage, PageNotFound } from "@dyad/domain";
import type { PageState, PlayContext, SourceSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { Cover } from "../../component/cover.tsx";
import { Action } from "../../component/dialog-actions.tsx";
import { useListScreen } from "../../component/list-screen.tsx";
import { RowList, TrackRow, selectableRows } from "../../component/row-list.tsx";
import { ListTitle } from "../../component/track-list.tsx";
import { useArtwork } from "../../component/use-artwork.ts";
import { ArtistItem } from "../../context/action-items.ts";
import { commands } from "../../context/keymap.ts";
import { Route } from "../../context/router.ts";
import { useReload } from "../../context/screen-app.ts";
import type { ScreenApp } from "../../context/screen-app.ts";
import { useTheme } from "../../theme/theme.ts";
import { albumHeader, albumPageRows } from "./album.ts";
import { artistHeader, artistPageRows } from "./artist.ts";

export const pageRows = (page: ArtistPage | AlbumPage) =>
  Schema.is(AlbumPage)(page) ? albumPageRows(page) : artistPageRows(page);

// RETURN TYPE: the atoms have different page types, and `useAtomValue` needs one atom type
const pageAtom = (
  atoms: ServerAtoms,
  route: typeof Route.cases.Artist.Type | typeof Route.cases.Album.Type,
): Atom.Atom<AsyncResult.AsyncResult<ArtistPage | AlbumPage, unknown>> =>
  Route.guards.Artist(route) ? atoms.artistPage(route.ref) : atoms.albumPage(route.ref);

/** Play all, shuffle, add all and the download of a page that has songs */
export const listActions = (
  app: ScreenApp,
  sources: ReadonlyArray<SourceSummary>,
  context: typeof PlayContext.Type,
  download: Pick<DownloadPin, "kind" | "id" | "title"> | null,
) => {
  if (sources.length === 0) return [];
  const sourceIds = sources.map((source) => source.id);
  return [
    new Action({
      command: commands.playAll,
      label: "Play all",
      run: () => app.player.playList(sources, 0, context),
    }),
    new Action({
      command: commands.shuffleAll,
      label: "Shuffle",
      run: () => app.player.shuffleList(sources, context),
    }),
    new Action({
      command: commands.addAllToQueue,
      label: "Add all to queue",
      run: () => app.player.addToQueue(sources, context),
    }),
    ...(download === null
      ? []
      : app.downloadAction(
          { ...download, sourceIds },
          commands.downloadAll,
          commands.removeAllDownload,
        )),
  ];
};

export const statusText = (state: PageState, providerName: string | null) => {
  const provider = providerName ?? "the provider";
  if (state.status === "local") return "Local library";
  const saved = state.fetchedAt !== null;
  if (state.status === "fetching") {
    return saved ? `${provider} · updating…` : `Fetching from ${provider}…`;
  }
  if (state.status === "fresh") return provider;
  const reason = state.reason ?? `Cannot reach ${provider}`;
  return saved ? `${reason} · showing saved data` : reason;
};

// Until the page loads, the header shows the name from the row that opened it
const headerOf = (page: ArtistPage | AlbumPage | null, hint: string, loading: boolean) => {
  if (page === null) {
    const status = loading ? "Loading…" : "";
    return { title: hint, subtitle: "", details: "", status, artworkUrl: null };
  }

  const header = Schema.is(AlbumPage)(page) ? albumHeader(page, hint) : artistHeader(page, hint);
  return { ...header, status: statusText(page.state, page.providerName) };
};

const coverWidth = 8;
const coverHeight = 4;

function PageHeader(props: {
  readonly page: ArtistPage | AlbumPage | null;
  readonly hint: string;
  readonly loading: boolean;
}) {
  const theme = useTheme();
  const header = headerOf(props.page, props.hint, props.loading);
  const artwork = useArtwork(header.artworkUrl);

  return (
    <box flexDirection="row" gap={2} height={coverHeight} marginTop={1} marginBottom={1}>
      <Cover artwork={artwork} width={coverWidth} height={coverHeight} />
      <box flexDirection="column" flexGrow={1}>
        <text wrapMode="none" fg={theme.text}>
          <strong>{header.title}</strong>
        </text>
        <text wrapMode="none" fg={theme.accent}>
          {header.subtitle}
        </text>
        <text wrapMode="none" fg={theme.muted}>
          {header.details}
        </text>
        <text wrapMode="none" fg={theme.faint}>
          {header.status}
        </text>
      </box>
    </box>
  );
}

const isNotFound = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) &&
  Option.exists(Cause.findErrorOption(result.cause), Schema.is(PageNotFound));

export function PageScreen(props: {
  readonly app: ScreenApp;
  readonly route: typeof Route.cases.Artist.Type | typeof Route.cases.Album.Type;
}) {
  const { app, route } = props;
  const theme = useTheme();
  const atom = pageAtom(app.atoms, route);
  const result = useAtomValue(atom);
  useReload(app, useAtomRefresh(atom));
  // The footer renders twice a second, so the page keeps its rows between renders
  const rows = useMemo(
    () => (AsyncResult.isSuccess(result) ? pageRows(result.value) : []),
    [result],
  );
  const page = AsyncResult.isSuccess(result) ? result.value : null;

  const actions = () => {
    const sources = rows.flatMap((row) =>
      row instanceof TrackRow && row.track.playable ? [row.track.source] : [],
    );
    if (Schema.is(AlbumPage)(page)) {
      const tracks = page.tracks.flatMap((track) => (track.edition === null ? [track.source] : []));
      const marks =
        page.albumId === null
          ? []
          : app.libraryMarks.album(page.albumId, page.album?.title ?? "the album", tracks);
      const album = { kind: "album" as const, id: route.ref, title: route.hint };
      return [...marks, ...listActions(app, sources, "album", album)];
    }
    if (Schema.is(ArtistPage)(page)) {
      const marks =
        page.artistId === null
          ? []
          : app.libraryMarks.artist(page.artistId, page.name ?? "the artist");
      const radio =
        page.name === null
          ? []
          : app.itemActions(new ArtistItem({ name: page.name, artistId: page.artistId }));
      return [...marks, ...radio, ...listActions(app, sources, "artist", null)];
    }
    return [];
  };

  const list = useListScreen(app, { title: route.hint, items: selectableRows(rows), actions });

  const message = () => {
    if (isNotFound(result)) {
      return "This page does not exist anymore. The tags of its files can have changed. Press esc to go back.";
    }
    if (AsyncResult.isFailure(result)) return "Cannot load the page. Press r to try again.";
    return null;
  };
  const failure = message();

  return (
    <box flexDirection="column" flexGrow={1}>
      <ListTitle title={app.breadcrumb} detail="" />
      <PageHeader page={page} hint={route.hint} loading={AsyncResult.isInitial(result)} />
      {failure === null ? (
        <RowList
          rows={rows}
          selected={list.selectedKey}
          playingId={app.player.current?.source.id ?? null}
          empty={page === null ? "" : "Nothing on this page"}
          onSelect={list.selectRow}
          onActivate={list.activateRow}
        />
      ) : (
        <text fg={theme.muted} paddingX={1}>
          {failure}
        </text>
      )}
    </box>
  );
}
