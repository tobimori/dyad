import { formatDuration, songLine, sourceLabel, titleOf } from "@dyad/client-runtime";
import type { QueueEntry, SourceSegment } from "@dyad/domain";
import { TextAttributes } from "@opentui/core";
import { useRef, useState } from "react";

import { ProgressBar } from "../component/bars.tsx";
import { Cover } from "../component/cover.tsx";
import { scrollOffset, useRowClick } from "../component/track-list.tsx";
import type { Artwork } from "../component/use-artwork.ts";
import { useTheme } from "../theme/theme.ts";
import { fit } from "../ui/format.ts";

/** `Artist – Title` of a track in a DJ set */
export const segmentLine = (segment: SourceSegment) =>
  segment.artist === null ? segment.title : `${segment.artist} – ${segment.title}`;

// The time column fits `12:34:56`
const segmentTimeWidth = 8;

/** A click selects a track; a double click plays from it */
function Tracklist(props: {
  readonly segments: ReadonlyArray<SourceSegment>;
  /** -1 when no track of the set plays */
  readonly current: number;
  readonly selected: number;
  readonly width: number;
  readonly onSelect: (index: number) => void;
  readonly onPlay: (index: number) => void;
}) {
  const theme = useTheme();
  const [height, setHeight] = useState(0);
  const offset = useRef(0);
  const click = useRowClick(props.onSelect, props.onPlay);

  const rows = Math.max(1, height);
  offset.current = scrollOffset(offset.current, props.selected, rows, props.segments.length);
  const visible = props.segments.slice(offset.current, offset.current + rows);
  const titleWidth = props.width - segmentTimeWidth - 3;

  return (
    <box flexDirection="column" marginTop={1} flexGrow={1} flexShrink={1} overflow="hidden">
      <text fg={theme.muted} flexShrink={0}>
        <strong>Tracklist</strong>
      </text>
      <box
        flexDirection="column"
        flexGrow={1}
        onSizeChange={function () {
          setHeight(this.height);
        }}
      >
        {visible.map((segment, row) => {
          const index = offset.current + row;
          const playing = index === props.current;
          const selected = index === props.selected;
          return (
            <box
              key={index}
              flexDirection="row"
              gap={1}
              height={1}
              backgroundColor={selected ? theme.selection : "transparent"}
              onMouseDown={() => click(index)}
            >
              <text width={1} fg={theme.accent}>
                {playing ? "▶" : " "}
              </text>
              <text width={segmentTimeWidth} textAlign="right" fg={theme.muted}>
                {formatDuration(segment.startMs)}
              </text>
              <text
                width={titleWidth}
                fg={playing ? theme.accent : theme.text}
                attributes={selected ? TextAttributes.BOLD : TextAttributes.NONE}
                wrapMode="none"
              >
                {fit(segmentLine(segment), titleWidth)}
              </text>
            </box>
          );
        })}
      </box>
    </box>
  );
}

const details = (entry: QueueEntry) =>
  [sourceLabel(entry.source), formatDuration(entry.source.durationMs)]
    .filter((part) => part !== "")
    .join(" · ");

function UpNext(props: { readonly entries: ReadonlyArray<QueueEntry>; readonly width: number }) {
  const theme = useTheme();
  if (props.entries.length === 0) return null;

  return (
    <box flexDirection="column" marginTop={1} flexShrink={1} overflow="hidden">
      <text fg={theme.muted} flexShrink={0}>
        <strong>Up next</strong>
      </text>
      {props.entries.map((entry) => (
        <text key={entry.id} fg={theme.muted} wrapMode="none" flexShrink={0}>
          {fit(songLine(entry.source), props.width)}
        </text>
      ))}
    </box>
  );
}

export function NowPlayingPanel(props: {
  readonly entry: QueueEntry | undefined;
  /** The track of the DJ set that plays */
  readonly segment: SourceSegment | undefined;
  readonly upNext: ReadonlyArray<QueueEntry>;
  readonly artwork: Artwork | null;
  readonly width: number;
  readonly height: number;
  readonly onOpen: () => void;
}) {
  const theme = useTheme();
  const innerWidth = props.width - 4;
  // Terminal cells are about twice as high as wide. The text below the cover needs about 10 rows.
  const coverHeight = Math.max(0, Math.min(Math.floor(innerWidth / 2), props.height - 12));
  const line = (text: string) => fit(text, innerWidth);

  if (props.entry === undefined) {
    return (
      <box
        width={props.width}
        backgroundColor={theme.panel}
        justifyContent="center"
        alignItems="center"
      >
        <text fg={theme.muted}>Nothing is playing</text>
      </box>
    );
  }

  const source = props.entry.source;

  return (
    <box
      width={props.width}
      flexDirection="column"
      backgroundColor={theme.panel}
      paddingX={2}
      paddingY={1}
      onMouseDown={props.onOpen}
    >
      {coverHeight > 0 && (
        <box marginBottom={1} alignItems="center">
          <Cover artwork={props.artwork} width={coverHeight * 2} height={coverHeight} />
        </box>
      )}
      <text fg={theme.text} wrapMode="none">
        <strong>{line(titleOf(source))}</strong>
      </text>
      <text fg={theme.accent} wrapMode="none">
        {line(source.artist ?? "Unknown artist")}
      </text>
      <text fg={theme.muted} wrapMode="none">
        {line(source.album ?? "")}
      </text>
      <text fg={theme.faint} wrapMode="none">
        {line(details(props.entry))}
      </text>
      {props.segment !== undefined && (
        <text fg={theme.accent} wrapMode="none">
          {line(`▶ ${segmentLine(props.segment)}`)}
        </text>
      )}
      <UpNext entries={props.upNext} width={innerWidth} />
    </box>
  );
}

// Below this width, the cover goes above the text
const sideBySideMinWidth = 64;

export function NowPlayingView(props: {
  readonly entry: QueueEntry | undefined;
  /** The tracklist of a DJ set. The view shows it instead of the next entries. */
  readonly segments: ReadonlyArray<SourceSegment>;
  /** The index of the track of the set that plays, or -1 */
  readonly currentSegment: number;
  readonly selectedSegment: number;
  readonly onSelectSegment: (index: number) => void;
  readonly onPlaySegment: (index: number) => void;
  readonly upNext: ReadonlyArray<QueueEntry>;
  readonly artwork: Artwork | null;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly width: number;
  readonly height: number;
  readonly onSeek: (ms: number) => void;
}) {
  const theme = useTheme();

  if (props.entry === undefined) {
    return (
      <box flexGrow={1} justifyContent="center" alignItems="center">
        <text fg={theme.muted}>Nothing is playing. Press q for the queue or / to search.</text>
      </box>
    );
  }

  const source = props.entry.source;
  const segment = props.segments[props.currentSegment];
  const sideBySide = props.width >= sideBySideMinWidth;
  // The padding takes two rows and four columns
  const space = { width: props.width - 4, height: props.height - 2 };
  // Terminal cells are about twice as high as wide
  const coverHeight = sideBySide
    ? Math.min(space.height, Math.floor((space.width * 0.5) / 2))
    : Math.max(0, Math.min(Math.floor(space.width / 2), space.height - 9));
  const textWidth = sideBySide ? space.width - coverHeight * 2 - 3 : space.width;
  const line = (text: string) => fit(text, textWidth);

  return (
    <box
      flexGrow={1}
      flexDirection={sideBySide ? "row" : "column"}
      // The tracklist takes the full height
      alignItems={sideBySide && props.segments.length === 0 ? "center" : "stretch"}
      gap={sideBySide ? 3 : 1}
      paddingX={2}
      paddingY={1}
    >
      {coverHeight > 0 && (
        <box alignItems="center">
          <Cover artwork={props.artwork} width={coverHeight * 2} height={coverHeight} />
        </box>
      )}
      <box
        flexDirection="column"
        flexGrow={1}
        flexShrink={1}
        maxHeight={space.height}
        overflow="hidden"
      >
        <text fg={theme.text} wrapMode="none" flexShrink={0}>
          <strong>{line(titleOf(source))}</strong>
        </text>
        <text fg={theme.accent} wrapMode="none" flexShrink={0}>
          {line(source.artist ?? "Unknown artist")}
        </text>
        <text fg={theme.muted} wrapMode="none" flexShrink={0}>
          {line(source.album ?? "")}
        </text>
        <text fg={theme.faint} wrapMode="none" flexShrink={0}>
          {line(details(props.entry))}
        </text>
        {segment !== undefined && (
          <text fg={theme.accent} wrapMode="none" flexShrink={0}>
            {line(`▶ ${segmentLine(segment)}`)}
          </text>
        )}
        <box marginTop={1} flexShrink={0}>
          <ProgressBar
            positionMs={props.positionMs}
            durationMs={props.durationMs}
            onSeek={props.onSeek}
          />
        </box>
        {props.segments.length === 0 ? (
          <UpNext entries={props.upNext} width={textWidth} />
        ) : (
          <Tracklist
            segments={props.segments}
            current={props.currentSegment}
            selected={props.selectedSegment}
            width={textWidth}
            onSelect={props.onSelectSegment}
            onPlay={props.onPlaySegment}
          />
        )}
      </box>
    </box>
  );
}
