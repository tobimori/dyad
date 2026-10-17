import { formatDuration, formatTotalDuration, titleOf } from "@dyad/client-runtime";
import type { ServerAtoms } from "@dyad/client-runtime";
import { AlbumPage, AlbumSection, PageNotFound, TrackSection } from "@dyad/domain";
import type {
  AlbumCard,
  ArtistCard,
  ArtistPage,
  PageState,
  PageTrack,
  SourceSummary,
} from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { TextAttributes } from "@opentui/core";
import { Cause, Data, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useRef, useState } from "react";

import { fit } from "./format.ts";
import { Cover } from "./now-playing.tsx";
import { AlbumRoute, ArtistRoute } from "./routes.ts";
import type { PageRoute, SectionRoute } from "./routes.ts";
import { useTheme } from "./theme.ts";
import { ListTitle, scrollOffset, useRowClick } from "./track-list.tsx";
import { useArtwork } from "./use-artwork.ts";

/** A heading or the empty row above it. The cursor skips it. */
export class HeadingRow extends Data.Class<{
  readonly key: string;
  readonly label: string;
}> {}

export class TrackRow extends Data.Class<{
  readonly key: string;
  readonly track: PageTrack;
  /** `return` plays these from this track */
  readonly section: ReadonlyArray<SourceSummary>;
  readonly context: "album" | "artist";
}> {}

export class AlbumRow extends Data.Class<{
  readonly key: string;
  readonly album: AlbumCard;
}> {}

export class ArtistRow extends Data.Class<{
  readonly key: string;
  readonly artist: ArtistCard;
}> {}

export type SelectableRow = TrackRow | AlbumRow | ArtistRow;
export type Row = HeadingRow | SelectableRow;

export const selectableRows = (rows: ReadonlyArray<Row>) =>
  rows.flatMap((row) => (row instanceof HeadingRow ? [] : [row]));

const sectionHeadings = {
  top_tracks: "Top tracks",
  tracks: "Tracks",
  albums: "Albums",
  singles_eps: "Singles and EPs",
  compilations: "Compilations",
  live: "Live",
  appears_on: "Appears on",
  in_library: "In your library",
  other: "Other releases",
  similar_artists: "Similar artists",
};

// Own releases only, not "Appears on"
const isRelease = (section: AlbumSection) =>
  section.kind !== "appears_on" && section.kind !== "in_library";

const typeLabels = { album: "Album", single: "Single", ep: "EP" };

/** Empty for an unclassified release */
const albumType = (album: AlbumCard) => {
  if (album.secondaryTypes.includes("compilation")) return "Compilation";
  if (album.secondaryTypes.includes("live")) return "Live";
  return album.primaryType === null ? "" : typeLabels[album.primaryType];
};

const yearOf = (album: AlbumCard) => album.releaseDate?.slice(0, 4) ?? "";

const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const artistRows = (artists: ReadonlyArray<ArtistCard>) =>
  artists.map((artist) => new ArtistRow({ key: artist.ref, artist }));

export const albumRows = (albums: ReadonlyArray<AlbumCard>) =>
  albums.map((album) => new AlbumRow({ key: album.ref, album }));

const trackRows = (
  keyPrefix: string,
  tracks: ReadonlyArray<PageTrack>,
  context: "album" | "artist",
) => {
  const section = tracks.flatMap((track) => (track.playable ? [track.source] : []));
  return tracks.map(
    (track) => new TrackRow({ key: `${keyPrefix}:${track.source.id}`, track, section, context }),
  );
};

const headed = (key: string, label: string, first: boolean, rows: ReadonlyArray<Row>) => [
  ...(first ? [] : [new HeadingRow({ key: `space:${key}`, label: "" })]),
  new HeadingRow({ key: `heading:${key}`, label }),
  ...rows,
];

// Keys use the section kind, not the position, so a new section does not move the cursor
const artistPageRows = (page: ArtistPage) => {
  const releaseSections = page.sections.filter(Schema.is(AlbumSection)).filter(isRelease);
  const onlyOther = releaseSections.length === 1 && releaseSections[0]?.kind === "other";

  return page.sections.flatMap((section, index) => {
    const first = index === 0;

    if (Schema.is(TrackSection)(section)) {
      const rows = trackRows(section.kind, section.tracks, "artist");
      return headed(section.kind, sectionHeadings[section.kind], first, rows);
    }

    if (Schema.is(AlbumSection)(section)) {
      const label =
        onlyOther && section.kind === "other" ? "Releases" : sectionHeadings[section.kind];
      const rows = section.albums.map(
        (album) => new AlbumRow({ key: `${section.kind}:${album.ref}`, album }),
      );
      return headed(section.kind, label, first, rows);
    }

    const rows = section.artists.map(
      (artist) => new ArtistRow({ key: `${section.kind}:${artist.ref}`, artist }),
    );
    return headed(section.kind, sectionHeadings[section.kind], first, rows);
  });
};

// All discs play as one section; disc headings show only for more than one disc
const albumPageRows = (page: AlbumPage) => {
  const rows = trackRows("track", page.tracks, "album");
  const discs = new Set(page.tracks.map((track) => track.disc ?? 1));
  if (discs.size < 2) return rows;

  return rows.flatMap((row, index) => {
    const disc = row.track.disc ?? 1;
    const previous = rows[index - 1];
    if (previous !== undefined && (previous.track.disc ?? 1) === disc) return [row];
    return headed(`disc:${disc}`, `Disc ${disc}`, index === 0, [row]);
  });
};

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
  if (state.status === "fetching") return `Fetching from ${provider}…`;
  if (state.status === "fresh") return provider;
  return state.reason ?? `Cannot reach ${provider}`;
};

// Until the page loads, the header shows the name from the row that opened it
const headerOf = (page: ArtistPage | AlbumPage | null, hint: string, loading: boolean) => {
  if (page === null) {
    const status = loading ? "Loading…" : "";
    return { title: hint, subtitle: "", details: "", status, artworkUrl: null };
  }

  const status = statusText(page.state, page.providerName);

  if (Schema.is(AlbumPage)(page)) {
    const totalMs = page.tracks.reduce((total, track) => total + (track.source.durationMs ?? 0), 0);
    const details = [
      page.album === null ? "" : yearOf(page.album),
      page.album === null ? "" : albumType(page.album),
      counted(page.tracks.length, "track"),
      totalMs === 0 ? "" : formatTotalDuration(totalMs),
    ];
    return {
      title: page.album?.title ?? hint,
      subtitle: page.album?.artist ?? "",
      details: details.filter((detail) => detail !== "").join(" · "),
      status,
      artworkUrl: page.album?.artworkUrl ?? null,
    };
  }

  const releases = page.sections
    .filter(Schema.is(AlbumSection))
    .filter(isRelease)
    .reduce((total, section) => total + section.albums.length, 0);
  const tracks = page.sections
    .filter(Schema.is(TrackSection))
    .reduce((total, section) => total + section.tracks.length, 0);
  const details = [
    releases === 0 ? "" : counted(releases, "release"),
    tracks === 0 ? "" : counted(tracks, "track"),
  ];
  return {
    title: page.name ?? hint,
    subtitle: "Artist",
    details: details.filter((detail) => detail !== "").join(" · "),
    status,
    artworkUrl: page.artworkUrl,
  };
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

const gap = 2;
const markerWidth = 1;
const numberWidth = 3;
const timeWidth = 6;
const yearWidth = 4;
const typeWidth = 11;
const countWidth = 9;
// Below this width, album rows leave out the type
const wideMinWidth = 68;

function Cell(props: {
  readonly text: string;
  readonly width: number;
  readonly fg: string;
  readonly bold: boolean;
  readonly align?: "left" | "right";
}) {
  return (
    <text
      width={props.width}
      fg={props.fg}
      textAlign={props.align ?? "left"}
      attributes={props.bold ? TextAttributes.BOLD : TextAttributes.NONE}
    >
      {fit(props.text, props.width)}
    </text>
  );
}

function RowCells(props: {
  readonly row: SelectableRow;
  readonly width: number;
  readonly selected: boolean;
  readonly playing: boolean;
}) {
  const theme = useTheme();
  const row = props.row;
  const bold = props.selected;
  const secondary = props.selected ? theme.text : theme.muted;
  const marker = (
    <text width={markerWidth} fg={theme.accent}>
      {props.playing ? "▶" : " "}
    </text>
  );

  if (row instanceof TrackRow) {
    const source = row.track.source;
    const flexible = Math.max(0, props.width - markerWidth - numberWidth - timeWidth - gap * 4);
    const titleWidth = Math.floor(flexible * 0.6);
    const fg = row.track.playable ? theme.text : theme.faint;
    return (
      <>
        {marker}
        <Cell
          text={row.track.number === null ? "" : String(row.track.number)}
          width={numberWidth}
          fg={theme.muted}
          bold={false}
          align="right"
        />
        <Cell
          text={titleOf(source)}
          width={titleWidth}
          fg={props.playing ? theme.accent : fg}
          bold={bold}
        />
        <Cell
          text={source.artist ?? ""}
          width={flexible - titleWidth}
          fg={row.track.playable ? secondary : theme.faint}
          bold={bold}
        />
        <Cell
          text={formatDuration(source.durationMs)}
          width={timeWidth}
          fg={row.track.playable ? secondary : theme.faint}
          bold={bold}
          align="right"
        />
      </>
    );
  }

  if (row instanceof AlbumRow) {
    const album = row.album;
    const wide = props.width >= wideMinWidth;
    const fixed = markerWidth + yearWidth + countWidth + (wide ? typeWidth + gap : 0) + gap * 4;
    const flexible = Math.max(0, props.width - fixed);
    const titleWidth = Math.floor(flexible * 0.55);
    return (
      <>
        {marker}
        <Cell text={album.title} width={titleWidth} fg={theme.text} bold={bold} />
        <Cell text={album.artist ?? ""} width={flexible - titleWidth} fg={secondary} bold={bold} />
        <Cell text={yearOf(album)} width={yearWidth} fg={secondary} bold={bold} />
        {wide && <Cell text={albumType(album)} width={typeWidth} fg={secondary} bold={bold} />}
        <Cell
          text={album.trackCount === null ? "" : counted(album.trackCount, "track")}
          width={countWidth}
          fg={secondary}
          bold={bold}
          align="right"
        />
      </>
    );
  }

  return (
    <>
      {marker}
      <Cell
        text={row.artist.name}
        width={Math.max(0, props.width - markerWidth - gap)}
        fg={theme.text}
        bold={bold}
      />
    </>
  );
}

/** The cursor skips headings. A double click opens or plays a row. */
export function RowList(props: {
  readonly rows: ReadonlyArray<Row>;
  readonly selected: string | null;
  readonly playingId: string | null;
  readonly empty: string;
  readonly onSelect: (row: SelectableRow) => void;
  readonly onActivate: (row: SelectableRow) => void;
}) {
  const theme = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const offset = useRef(0);

  const rowAt = (index: number) => {
    const row = props.rows[index];
    return row === undefined || row instanceof HeadingRow ? undefined : row;
  };
  const click = useRowClick(
    (index) => {
      const row = rowAt(index);
      if (row !== undefined) props.onSelect(row);
    },
    (index) => {
      const row = rowAt(index);
      if (row !== undefined) props.onActivate(row);
    },
  );

  const selectedIndex = Math.max(
    0,
    props.rows.findIndex((row) => row.key === props.selected),
  );
  const height = Math.max(1, size.height);
  // One column of padding on each side
  const width = size.width - 2;
  offset.current = scrollOffset(offset.current, selectedIndex, height, props.rows.length);
  const visible = props.rows.slice(offset.current, offset.current + height);

  const scroll = (delta: number) => {
    const selectable = selectableRows(props.rows);
    const position = selectable.findIndex((row) => row.key === props.selected);
    const next = selectable[Math.max(0, Math.min(selectable.length - 1, position + delta))];
    if (next !== undefined) props.onSelect(next);
  };

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      onSizeChange={function () {
        setSize({ width: this.width, height: this.height });
      }}
      onMouseScroll={(event) => scroll(event.scroll?.direction === "up" ? -1 : 1)}
    >
      {props.rows.length === 0 && (
        <text fg={theme.muted} paddingX={1}>
          {props.empty}
        </text>
      )}
      {visible.map((row, position) => {
        const index = offset.current + position;

        if (row instanceof HeadingRow) {
          return (
            <box key={row.key} height={1} paddingX={1}>
              <text wrapMode="none" fg={theme.accent}>
                <strong>{row.label}</strong>
              </text>
            </box>
          );
        }

        const selected = index === selectedIndex;
        const playing = row instanceof TrackRow && row.track.source.id === props.playingId;
        return (
          <box
            key={row.key}
            flexDirection="row"
            gap={gap}
            paddingX={1}
            height={1}
            backgroundColor={selected ? theme.selection : "transparent"}
            onMouseDown={() => click(index)}
          >
            <RowCells row={row} width={width} selected={selected} playing={playing} />
          </box>
        );
      })}
    </box>
  );
}
