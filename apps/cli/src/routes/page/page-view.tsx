import type { ServerAtoms } from "@dyad/client-runtime";
import { AlbumPage, PageNotFound } from "@dyad/domain";
import type { ArtistPage, PageState } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";

import { Cover } from "../../component/cover.tsx";
import { RowList } from "../../component/row-list.tsx";
import type { Row, SelectableRow } from "../../component/row-list.tsx";
import { ListTitle } from "../../component/track-list.tsx";
import { useArtwork } from "../../component/use-artwork.ts";
import { AlbumRoute, ArtistRoute } from "../../context/routes.ts";
import type { PageRoute, SectionRoute } from "../../context/routes.ts";
import { useTheme } from "../../theme/theme.ts";
import { albumHeader, albumPageRows } from "./album.ts";
import { artistHeader, artistPageRows } from "./artist.ts";

export const pageRows = (page: ArtistPage | AlbumPage) =>
  Schema.is(AlbumPage)(page) ? albumPageRows(page) : artistPageRows(page);

const noPage = Atom.make(AsyncResult.initial());

// RETURN TYPE: the atoms have different page types, and `useAtomValue` needs one atom type
const pageAtom = (
  atoms: ServerAtoms,
  route: SectionRoute | PageRoute,
): Atom.Atom<AsyncResult.AsyncResult<ArtistPage | AlbumPage, unknown>> => {
  if (route instanceof ArtistRoute) return atoms.artistPage(route.ref);
  if (route instanceof AlbumRoute) return atoms.albumPage(route.ref);
  return noPage;
};

/** A sidebar section has no page and gets an initial result */
export function usePage(atoms: ServerAtoms, route: SectionRoute | PageRoute) {
  const atom = pageAtom(atoms, route);
  return { result: useAtomValue(atom), refresh: useAtomRefresh(atom) };
}

const statusText = (state: PageState, providerName: string | null) => {
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

export function PageView(props: {
  readonly breadcrumb: string;
  readonly hint: string;
  readonly result: AsyncResult.AsyncResult<ArtistPage | AlbumPage, unknown>;
  readonly rows: ReadonlyArray<Row>;
  readonly selected: string | null;
  readonly playingId: string | null;
  readonly onSelect: (row: SelectableRow) => void;
  readonly onActivate: (row: SelectableRow) => void;
}) {
  const theme = useTheme();
  const page = AsyncResult.isSuccess(props.result) ? props.result.value : null;

  const message = () => {
    if (isNotFound(props.result)) {
      return "This page does not exist anymore. The tags of its files can have changed. Press esc to go back.";
    }
    if (AsyncResult.isFailure(props.result)) return "Cannot load the page. Press r to try again.";
    return null;
  };
  const failure = message();

  return (
    <box flexDirection="column" flexGrow={1}>
      <ListTitle title={props.breadcrumb} detail="" />
      <PageHeader page={page} hint={props.hint} loading={AsyncResult.isInitial(props.result)} />
      {failure === null ? (
        <RowList
          rows={props.rows}
          selected={props.selected}
          playingId={props.playingId}
          empty={page === null ? "" : "Nothing on this page"}
          onSelect={props.onSelect}
          onActivate={props.onActivate}
        />
      ) : (
        <text fg={theme.muted} paddingX={1}>
          {failure}
        </text>
      )}
    </box>
  );
}
