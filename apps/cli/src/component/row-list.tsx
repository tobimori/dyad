import { formatDuration, titleOf } from "@dyad/client-runtime";
import { catalogArtistId } from "@dyad/domain";
import type {
  PlayContext,
  AlbumCard,
  ArtistCard,
  PageTrack,
  PlaylistSummary,
  SourceSummary,
} from "@dyad/domain";
import { TextAttributes } from "@opentui/core";
import { Array as Arr, Data, Option } from "effect";
import { useRef, useState } from "react";

import { useTheme } from "../theme/theme.ts";
import { fit } from "../ui/format.ts";
import { markerOf, useMarks } from "../context/marks.tsx";
import { Cover } from "./cover.tsx";
import { scrollOffset, useRowClick, videoMark } from "./track-list.tsx";
import { useArtwork } from "./use-artwork.ts";

/** A heading or the empty row above it. The cursor skips it. */
export class HeadingRow extends Data.Class<{
  readonly key: string;
  readonly label: string;
  /** Dim text after the label, for example the provider of a chart */
  readonly detail?: string | undefined;
  /** A heading inside the section of the heading above it */
  readonly minor?: boolean | undefined;
}> {}

export class TrackRow extends Data.Class<{
  readonly key: string;
  readonly track: PageTrack;
  /** `return` plays these from this track */
  readonly section: ReadonlyArray<SourceSummary>;
  readonly context: typeof PlayContext.Type;
}> {}

export class AlbumRow extends Data.Class<{
  readonly key: string;
  readonly album: AlbumCard;
}> {}

export class ArtistRow extends Data.Class<{
  readonly key: string;
  readonly artist: ArtistCard;
}> {}

export class PlaylistRow extends Data.Class<{
  readonly key: string;
  readonly playlist: PlaylistSummary;
  /** The display name of the provider of a linked playlist */
  readonly providerName: string | null;
}> {}

/** Albums side by side with their covers. The cursor selects each album. */
export class AlbumStripRow extends Data.Class<{
  readonly key: string;
  readonly albums: ReadonlyArray<AlbumRow>;
}> {}

export type SelectableRow = TrackRow | AlbumRow | ArtistRow | PlaylistRow;
export type Row = HeadingRow | AlbumStripRow | SelectableRow;

export const selectableRows = (rows: ReadonlyArray<Row>) =>
  rows.flatMap<SelectableRow>((row) => {
    if (row instanceof HeadingRow) return [];
    return row instanceof AlbumStripRow ? row.albums : [row];
  });

const typeLabels = { album: "Album", single: "Single", ep: "EP" };

/** Empty for an unclassified release */
export const albumType = (album: AlbumCard) => {
  if (album.secondaryTypes.includes("compilation")) return "Compilation";
  if (album.secondaryTypes.includes("live")) return "Live";
  return album.primaryType === null ? "" : typeLabels[album.primaryType];
};

export const yearOf = (album: AlbumCard) => album.releaseDate?.slice(0, 4) ?? "";

export const counted = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

export const artistRows = (artists: ReadonlyArray<ArtistCard>) =>
  Arr.dedupeWith(artists, (a, b) => a.ref === b.ref).map(
    (artist) => new ArtistRow({ key: artist.ref, artist }),
  );

// The ref is the row key, which must be unique
export const albumRows = (albums: ReadonlyArray<AlbumCard>) =>
  Arr.dedupeWith(albums, (a, b) => a.ref === b.ref).map(
    (album) => new AlbumRow({ key: album.ref, album }),
  );

export const albumStrip = (key: string, albums: ReadonlyArray<AlbumCard>) =>
  new AlbumStripRow({
    key: `strip:${key}`,
    albums: Arr.dedupeWith(albums, (a, b) => a.ref === b.ref).map(
      (album) => new AlbumRow({ key: `${key}:${album.ref}`, album }),
    ),
  });

export const trackRows = (
  keyPrefix: string,
  tracks: ReadonlyArray<PageTrack>,
  context: typeof PlayContext.Type,
) => {
  const section = tracks.flatMap((track) => (track.playable ? [track.source] : []));
  return tracks.map(
    (track) => new TrackRow({ key: `${keyPrefix}:${track.source.id}`, track, section, context }),
  );
};

export const headed = (
  key: string,
  label: string,
  first: boolean,
  rows: ReadonlyArray<Row>,
  heading: { readonly detail?: string; readonly minor?: boolean } = {},
) => [
  ...(first ? [] : [new HeadingRow({ key: `space:${key}`, label: "" })]),
  new HeadingRow({ key: `heading:${key}`, label, ...heading }),
  ...rows,
];

const gap = 2;
const markerWidth = 1;
const numberWidth = 3;
const timeWidth = 6;
const yearWidth = 4;
const typeWidth = 11;
const countWidth = 9;
const playlistCountWidth = 11;
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

// The artist, then why Dyad suggests the track, dim
function ReasonCell(props: {
  readonly artist: string;
  readonly reason: string;
  readonly width: number;
  readonly fg: string;
  readonly bold: boolean;
}) {
  const theme = useTheme();
  const artist = fit(props.artist, props.width);
  const rest = props.width - artist.length - gap;
  return (
    <text
      width={props.width}
      fg={props.fg}
      attributes={props.bold ? TextAttributes.BOLD : TextAttributes.NONE}
    >
      {artist}
      {rest > 3 && <span fg={theme.faint}>{`  ${fit(props.reason, rest)}`}</span>}
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
  const marks = useMarks();
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
    const mark = marks.song(source);
    const flexible = Math.max(0, props.width - markerWidth - numberWidth - timeWidth - gap * 4);
    const titleWidth = Math.floor(flexible * 0.6);
    // A disliked song shows dim like one that cannot play
    const dim = !row.track.playable || marks.disliked(source);
    const fg = dim ? theme.faint : theme.text;
    return (
      <>
        <text
          width={markerWidth}
          fg={props.playing || mark === "favorite" ? theme.accent : theme.muted}
        >
          {props.playing ? "▶" : markerOf(mark, true)}
        </text>
        <Cell
          text={row.track.number === null ? "" : String(row.track.number)}
          width={numberWidth}
          fg={theme.muted}
          bold={false}
          align="right"
        />
        <text
          width={titleWidth}
          fg={props.playing ? theme.accent : fg}
          attributes={bold ? TextAttributes.BOLD : TextAttributes.NONE}
        >
          {fit(titleOf(source), titleWidth - (source.video ? videoMark.length : 0))}
          {source.video && <span fg={secondary}>{videoMark}</span>}
        </text>
        {row.track.reason === null ? (
          <Cell
            text={source.artist ?? ""}
            width={flexible - titleWidth}
            fg={dim ? theme.faint : secondary}
            bold={bold}
          />
        ) : (
          <ReasonCell
            artist={source.artist ?? ""}
            reason={row.track.reason}
            width={flexible - titleWidth}
            fg={secondary}
            bold={bold}
          />
        )}
        <Cell
          text={formatDuration(source.durationMs)}
          width={timeWidth}
          fg={dim ? theme.faint : secondary}
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

  if (row instanceof PlaylistRow) {
    const flexible = Math.max(0, props.width - markerWidth - playlistCountWidth - gap * 3);
    const nameWidth = Math.floor(flexible * 0.65);
    return (
      <>
        {marker}
        <Cell text={row.playlist.name} width={nameWidth} fg={theme.text} bold={bold} />
        <Cell
          text={row.providerName ?? ""}
          width={flexible - nameWidth}
          fg={secondary}
          bold={bold}
        />
        <Cell
          text={counted(row.playlist.entryCount, "track")}
          width={playlistCountWidth}
          fg={secondary}
          bold={bold}
          align="right"
        />
      </>
    );
  }

  const artistMark = Option.match(catalogArtistId(row.artist.ref), {
    onNone: () => undefined,
    onSome: marks.artist,
  });
  return (
    <>
      <text width={markerWidth} fg={theme.accent}>
        {props.playing ? "▶" : markerOf(artistMark, false)}
      </text>
      <Cell
        text={row.artist.name}
        width={Math.max(0, props.width - markerWidth - gap)}
        fg={artistMark === "disliked" ? theme.faint : theme.text}
        bold={bold}
      />
    </>
  );
}

/**
 * `up` and `down` move by rows and enter a strip at the album that it had last; `left` and
 * `right` move inside a strip
 */
export function useStripNavigation(rows: ReadonlyArray<Row>, selected: string | null) {
  const lastAlbum = useRef(new Map<string, string>());
  const lines = rows.flatMap((row) => (row instanceof HeadingRow ? [] : [row]));
  const lineAt = lines.findIndex(
    (line) =>
      line.key === selected ||
      (line instanceof AlbumStripRow && line.albums.some((album) => album.key === selected)),
  );
  const line = lines[lineAt];
  if (line instanceof AlbumStripRow && selected !== null) {
    lastAlbum.current.set(line.key, selected);
  }

  const entry = (target: AlbumStripRow | SelectableRow) =>
    target instanceof AlbumStripRow
      ? (lastAlbum.current.get(target.key) ?? target.albums[0]?.key)
      : target.key;
  return {
    /** The key `by` rows away */
    vertical: (by: number) => {
      const target = lines[Math.max(0, Math.min(lines.length - 1, lineAt + by))];
      return target === undefined ? undefined : entry(target);
    },
    /** The key `by` albums away in the strip of the selection */
    horizontal: (by: number) => {
      if (!(line instanceof AlbumStripRow)) return undefined;
      const at = line.albums.findIndex((album) => album.key === selected);
      return line.albums[Math.max(0, Math.min(line.albums.length - 1, at + by))]?.key;
    },
  };
}

// A cover of 16 by 8 cells is about square
const tileWidth = 16;
const coverHeight = 8;
const tileGap = 2;
// The cover, the title and the artist
const stripHeight = coverHeight + 2;

const heightOf = (row: Row) => (row instanceof AlbumStripRow ? stripHeight : 1);

function AlbumTile(props: {
  readonly album: AlbumCard;
  readonly selected: boolean;
  readonly onMouseDown: () => void;
}) {
  const theme = useTheme();
  const artwork = useArtwork(props.album.artworkUrl, true);
  const background = props.selected ? theme.selection : "transparent";
  return (
    <box width={tileWidth} flexDirection="column" onMouseDown={props.onMouseDown}>
      <Cover artwork={artwork} width={tileWidth} height={coverHeight} />
      <text height={1} wrapMode="none" bg={background} fg={theme.text}>
        {props.selected ? (
          <strong>{fit(props.album.title, tileWidth)}</strong>
        ) : (
          fit(props.album.title, tileWidth)
        )}
      </text>
      <text height={1} wrapMode="none" bg={background} fg={theme.muted}>
        {fit(props.album.artist ?? "", tileWidth)}
      </text>
    </box>
  );
}

// The first visible row: the selected row stays in view, and rows of different heights fill the
// height from there
const firstVisible = (
  rows: ReadonlyArray<Row>,
  previous: number,
  selected: number,
  height: number,
) => {
  const linesFrom = (start: number, end: number) =>
    rows.slice(start, end + 1).reduce((total, row) => total + heightOf(row), 0);
  let start = Math.min(previous, selected);
  while (start < selected && linesFrom(start, selected) > height) start += 1;
  while (start > 0 && linesFrom(start - 1, rows.length - 1) <= height) start -= 1;
  return start;
};

/** The cursor skips headings. A double click opens or plays a row. */
export function RowList(props: {
  readonly rows: ReadonlyArray<Row>;
  readonly selected: string | null;
  readonly playingId: string | null;
  readonly empty: string;
  readonly onSelect: (row: SelectableRow) => void;
  readonly onActivate: (row: SelectableRow) => void;
  /** For a list with strips, so that the wheel moves by rows */
  readonly navigation?: ReturnType<typeof useStripNavigation> | undefined;
}) {
  const theme = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const offset = useRef(0);
  // The first album that each strip shows. It moves only to show the selected album.
  const stripStarts = useRef(new Map<string, number>());

  const rowAt = (index: number) => {
    const row = props.rows[index];
    return row === undefined || row instanceof HeadingRow || row instanceof AlbumStripRow
      ? undefined
      : row;
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

  const tileClick = useRowClick(
    (index) => {
      const row = selectableRows(props.rows)[index];
      if (row !== undefined) props.onSelect(row);
    },
    (index) => {
      const row = selectableRows(props.rows)[index];
      if (row !== undefined) props.onActivate(row);
    },
  );
  const selectableIndex = (key: string) =>
    selectableRows(props.rows).findIndex((row) => row.key === key);

  const selectedIndex = Math.max(
    0,
    props.rows.findIndex(
      (row) =>
        row.key === props.selected ||
        (row instanceof AlbumStripRow && row.albums.some((album) => album.key === props.selected)),
    ),
  );
  const height = Math.max(1, size.height);
  // One column of padding on each side
  const width = size.width - 2;
  const strips = props.rows.some((row) => row instanceof AlbumStripRow);
  // Before the first layout the height is unknown, and an offset for one line skips the headings
  if (size.height > 0) {
    offset.current = strips
      ? firstVisible(props.rows, offset.current, selectedIndex, height)
      : scrollOffset(offset.current, selectedIndex, height, props.rows.length);
  }
  const visible = (() => {
    const shown: Array<Row> = [];
    let lines = 0;
    for (const row of props.rows.slice(offset.current)) {
      lines += heightOf(row);
      // A strip that is higher than the list shows cut
      if (lines > height && shown.length > 0) break;
      shown.push(row);
    }
    return shown;
  })();
  const tilesShown = Math.max(1, Math.floor((width + tileGap) / (tileWidth + tileGap)));

  const scroll = (delta: number) => {
    const selectable = selectableRows(props.rows);
    const position = selectable.findIndex((row) => row.key === props.selected);
    const key = props.navigation?.vertical(delta);
    const next =
      key === undefined
        ? selectable[Math.max(0, Math.min(selectable.length - 1, position + delta))]
        : selectable.find((row) => row.key === key);
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
              <text wrapMode="none" fg={row.minor === true ? theme.text : theme.accent}>
                <strong>{row.label}</strong>
                {row.detail !== undefined && row.detail !== "" && (
                  <span fg={theme.faint}>{`  ${row.detail}`}</span>
                )}
              </text>
            </box>
          );
        }

        if (row instanceof AlbumStripRow) {
          // The strip scrolls sideways so that the selected album shows
          const at = row.albums.findIndex((album) => album.key === props.selected);
          const previous = stripStarts.current.get(row.key) ?? 0;
          const wanted =
            at === -1 ? previous : Math.min(at, Math.max(previous, at - tilesShown + 1));
          const start = Math.max(0, Math.min(wanted, row.albums.length - tilesShown));
          stripStarts.current.set(row.key, start);
          return (
            <box key={row.key} height={stripHeight} flexDirection="row" gap={tileGap} paddingX={1}>
              {row.albums.slice(start, start + tilesShown).map((album) => (
                <AlbumTile
                  key={album.key}
                  album={album.album}
                  selected={album.key === props.selected}
                  onMouseDown={() => tileClick(selectableIndex(album.key))}
                />
              ))}
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
