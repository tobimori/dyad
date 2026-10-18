import { formatDuration, sourceLabel, titleOf, unavailableLabel } from "@dyad/client-runtime";
import type { LibraryEntry, PlayContext, SourceSummary } from "@dyad/domain";
import { TextAttributes } from "@opentui/core";
import { Clock, Data, Effect } from "effect";
import { useRef, useState } from "react";
import type { ReactNode } from "react";

import { useTheme } from "../theme/theme.ts";
import { fit } from "../ui/format.ts";

export class ListItem extends Data.Class<{
  /** Unique in the list, also when a source is in the list twice */
  readonly key: string;
  readonly source: SourceSummary;
  readonly context: typeof PlayContext.Type;
  /** Shown in place of the source */
  readonly label?: string | undefined;
}> {}

/** A library entry that the user cannot play. The list shows it dimmed and never queues it. */
export class UnavailableItem extends Data.Class<{
  readonly key: string;
  readonly entry: LibraryEntry;
  readonly label: string;
}> {}

export type TrackItem = ListItem | UnavailableItem;

export const listItems = (
  sources: ReadonlyArray<SourceSummary>,
  context: typeof PlayContext.Type,
) => sources.map((source) => new ListItem({ key: source.id, source, context }));

export const entryItems = <E extends LibraryEntry>(
  entries: ReadonlyArray<E>,
  context: typeof PlayContext.Type,
  keyOf: (entry: E) => string,
  labelOf: (entry: E) => string | undefined = () => undefined,
) =>
  entries.map((entry) => {
    const key = keyOf(entry);
    if (entry.source !== null) {
      return new ListItem({ key, source: entry.source, context, label: labelOf(entry) });
    }
    // The contract sets `unavailable` whenever `source` is `null`
    const label = entry.unavailable === null ? "" : unavailableLabel(entry.unavailable);
    return new UnavailableItem({ key, entry, label });
  });

/** Marks the items of the source that plays now */
export const playsSource = (sourceId: string | undefined) => (item: TrackItem) =>
  item instanceof ListItem && item.source.id === sourceId;

const doubleClickMs = 400;
// Rows that stay visible above and below the selection before the list scrolls
const scrollMargin = 2;

/** The list scrolls only when the selection comes near an edge */
export const scrollOffset = (previous: number, selected: number, rows: number, total: number) => {
  if (total <= rows) return 0;
  const margin = Math.min(scrollMargin, Math.floor((rows - 1) / 2));
  const upper = Math.min(previous, selected - margin);
  const lower = Math.max(upper, selected + margin + 1 - rows);
  return Math.max(0, Math.min(lower, total - rows));
};

/** A second click on the same row soon after activates it */
export function useRowClick(
  onSelect: (index: number) => void,
  onActivate: (index: number) => void,
) {
  const lastClick = useRef({ index: -1, at: 0 });

  return (index: number) => {
    const time = Effect.runSync(Clock.currentTimeMillis);
    const double = lastClick.current.index === index && time - lastClick.current.at < doubleClickMs;
    lastClick.current = { index, at: time };
    if (double) onActivate(index);
    else onSelect(index);
  };
}

const gap = 2;
const markerWidth = 1;
const timeWidth = 6;
const sourceWidth = 13;
// Below this width, the list leaves out the album and source columns
const wideMinWidth = 68;

const columnWidths = (width: number, wide: boolean) => {
  const columns = wide ? 6 : 4;
  const fixed = markerWidth + timeWidth + (wide ? sourceWidth : 0) + gap * (columns - 1);
  const flexible = Math.max(0, width - fixed);
  const title = Math.floor(flexible * (wide ? 0.4 : 0.55));
  const artist = wide ? Math.floor(flexible * 0.3) : flexible - title;
  return { title, artist, album: flexible - title - artist };
};

/** After the title of a source with `video` */
export const videoMark = " video";

function Columns(props: {
  readonly marker: string;
  readonly title: string;
  readonly video: boolean;
  readonly artist: string;
  readonly album: string;
  readonly time: string;
  readonly source: string;
  readonly width: number;
  readonly wide: boolean;
  readonly fg: string;
  /** Color of all columns after the title */
  readonly secondary: string;
  readonly accent: string;
  readonly attributes: number;
}) {
  const widths = columnWidths(props.width, props.wide);

  return (
    <>
      <text width={markerWidth} fg={props.accent}>
        {props.marker}
      </text>
      <text width={widths.title} fg={props.fg} attributes={props.attributes}>
        {fit(props.title, widths.title - (props.video ? videoMark.length : 0))}
        {props.video && <span fg={props.secondary}>{videoMark}</span>}
      </text>
      <text width={widths.artist} fg={props.secondary} attributes={props.attributes}>
        {fit(props.artist, widths.artist)}
      </text>
      {props.wide && (
        <text width={widths.album} fg={props.secondary} attributes={props.attributes}>
          {fit(props.album, widths.album)}
        </text>
      )}
      <text width={timeWidth} textAlign="right" fg={props.secondary} attributes={props.attributes}>
        {props.time}
      </text>
      {props.wide && (
        <text width={sourceWidth} fg={props.secondary} attributes={props.attributes}>
          {fit(props.source, sourceWidth)}
        </text>
      )}
    </>
  );
}

export function ListTitle(props: { readonly title: string; readonly detail: string }) {
  const theme = useTheme();

  return (
    <text wrapMode="none">
      <strong fg={theme.text}>{props.title}</strong>
      <span fg={theme.muted}>{props.detail === "" ? "" : `  ${props.detail}`}</span>
    </text>
  );
}

/** A click selects a row; a double click plays it */
export function TrackList(props: {
  readonly title: string;
  /** Shows between the title and the column header */
  readonly header?: ReactNode;
  readonly items: ReadonlyArray<TrackItem>;
  readonly selected: number;
  readonly playing: (item: TrackItem) => boolean;
  /** Rows above this index are history and show dimmed */
  readonly historyRows: number;
  readonly empty: string;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
}) {
  const theme = useTheme();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const offset = useRef(0);
  const click = useRowClick(props.onSelect, props.onActivate);

  const rows = Math.max(1, size.height);
  // The rows have one column of padding on each side
  const width = size.width - 2;
  const wide = width >= wideMinWidth;
  offset.current = scrollOffset(offset.current, props.selected, rows, props.items.length);
  const visible = props.items.slice(offset.current, offset.current + rows);

  const count = props.items.length === 1 ? "1 track" : `${props.items.length} tracks`;
  const rowColor = (played: boolean) => (played ? theme.muted : theme.text);

  return (
    <box
      flexDirection="column"
      flexGrow={1}
      onMouseScroll={(event) => {
        const delta = event.scroll?.direction === "up" ? -1 : 1;
        props.onSelect(Math.max(0, Math.min(props.items.length - 1, props.selected + delta)));
      }}
    >
      <ListTitle title={props.title} detail={props.items.length === 0 ? "" : count} />
      {props.header}
      <box flexDirection="row" gap={gap} paddingX={1} height={1} flexShrink={0}>
        <Columns
          marker=" "
          title="Title"
          video={false}
          artist="Artist"
          album="Album"
          time="Time"
          source="Source"
          width={width}
          wide={wide}
          fg={theme.muted}
          secondary={theme.muted}
          accent={theme.muted}
          attributes={TextAttributes.BOLD}
        />
      </box>
      <box
        flexDirection="column"
        flexGrow={1}
        onSizeChange={function () {
          setSize({ width: this.width, height: this.height });
        }}
      >
        {props.items.length === 0 && (
          <text fg={theme.muted} paddingX={1}>
            {props.empty}
          </text>
        )}
        {visible.map((item, row) => {
          const index = offset.current + row;
          const selected = index === props.selected;
          const playing = props.playing(item);
          const played = index < props.historyRows;
          const unavailable = item instanceof UnavailableItem;
          const track = unavailable ? item.entry : item.source;
          const color = unavailable ? theme.faint : rowColor(played);

          return (
            <box
              key={item.key}
              flexDirection="row"
              gap={gap}
              paddingX={1}
              height={1}
              backgroundColor={selected ? theme.selection : "transparent"}
              onMouseDown={() => click(index)}
            >
              <Columns
                marker={playing ? "▶" : " "}
                title={titleOf(track)}
                video={!unavailable && item.source.video}
                artist={track.artist ?? ""}
                album={track.album ?? ""}
                time={formatDuration(track.durationMs)}
                source={unavailable ? item.label : (item.label ?? sourceLabel(item.source))}
                width={width}
                wide={wide}
                fg={playing ? theme.accent : color}
                secondary={selected || unavailable ? color : theme.muted}
                accent={theme.accent}
                attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
              />
            </box>
          );
        })}
      </box>
    </box>
  );
}
