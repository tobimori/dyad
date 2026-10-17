import { formatDuration, titleOf } from "@dyad/client-runtime";
import type { AlbumCard, ArtistCard, PageTrack, SourceSummary } from "@dyad/domain";
import { TextAttributes } from "@opentui/core";
import { Data } from "effect";
import { useRef, useState } from "react";

import { useTheme } from "../theme/theme.ts";
import { fit } from "../ui/format.ts";
import { scrollOffset, useRowClick } from "./track-list.tsx";

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
  artists.map((artist) => new ArtistRow({ key: artist.ref, artist }));

export const albumRows = (albums: ReadonlyArray<AlbumCard>) =>
  albums.map((album) => new AlbumRow({ key: album.ref, album }));

export const trackRows = (
  keyPrefix: string,
  tracks: ReadonlyArray<PageTrack>,
  context: "album" | "artist",
) => {
  const section = tracks.flatMap((track) => (track.playable ? [track.source] : []));
  return tracks.map(
    (track) => new TrackRow({ key: `${keyPrefix}:${track.source.id}`, track, section, context }),
  );
};

export const headed = (key: string, label: string, first: boolean, rows: ReadonlyArray<Row>) => [
  ...(first ? [] : [new HeadingRow({ key: `space:${key}`, label: "" })]),
  new HeadingRow({ key: `heading:${key}`, label }),
  ...rows,
];

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
