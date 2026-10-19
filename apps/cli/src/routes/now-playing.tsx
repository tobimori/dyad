import { formatDuration, songLine, sourceLabel, titleOf } from "@dyad/client-runtime";
import type { QueueEntry, SourceSegment } from "@dyad/domain";
import { TextAttributes } from "@opentui/core";
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { Action } from "../component/dialog-actions.tsx";
import { pageStep, useItemCommands } from "../component/list-screen.tsx";
import { scrollOffset, useRowClick } from "../component/track-list.tsx";
import { SegmentItem, SongItem } from "../context/action-items.ts";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import { useScreenCommands } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";
import type { usePlayer } from "../playback/use-player.ts";
import { useTheme } from "../theme/theme.ts";
import { useToast } from "../ui/toast.tsx";
import { fit } from "../ui/format.ts";
import { Backdrop } from "../visualizer/backdrop.tsx";

/** `Artist – Title` of a track in a DJ set */
export const segmentLine = (segment: SourceSegment) =>
  segment.artist === null ? segment.title : `${segment.artist} – ${segment.title}`;

const upNextRows = 20;

/** The entries after the one that plays */
export const upNextOf = (player: ReturnType<typeof usePlayer>) => {
  const current = player.currentIndex;
  return current === null ? [] : player.entries.slice(current + 1, current + 1 + upNextRows);
};

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
  /** The cover of the source that plays, in a box of `width` by `height` cells */
  readonly cover: (width: number, height: number) => ReactNode;
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
          {props.cover(coverHeight * 2, coverHeight)}
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
// The text alone over the backdrop reads best in a narrow column
const detailsMaxWidth = 64;

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
  /** `details` shows the text without the cover, in a column over the backdrop */
  readonly overlay: "full" | "details";
  /** The cover shows a video, which gets a large 16:9 box above the text */
  readonly video: boolean;
  /** The cover of the source that plays, in a box of `width` by `height` cells */
  readonly cover: (width: number, height: number) => ReactNode;
  readonly width: number;
  readonly height: number;
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
  const textOnly = props.overlay === "details";
  const centered = textOnly && props.segments.length === 0;
  const video = !textOnly && props.video;
  const sideBySide = !textOnly && !video && props.width >= sideBySideMinWidth;
  // The padding takes two rows and four columns
  const space = { width: props.width - 4, height: props.height - 2 };
  // Terminal cells are about twice as high as wide
  const squareHeight = sideBySide
    ? Math.min(space.height, Math.floor((space.width * 0.5) / 2))
    : Math.max(0, Math.min(Math.floor(space.width / 2), space.height - 7));
  // The gap and the four lines of text stay visible
  const videoRows = Math.max(
    0,
    Math.min(
      space.height - 5 - (segment === undefined ? 0 : 1),
      Math.round((space.width * 9) / 32),
    ),
  );
  const cover = video
    ? { width: Math.min(space.width, Math.floor((videoRows * 32) / 9)), height: videoRows }
    : { width: squareHeight * 2, height: textOnly ? 0 : squareHeight };
  const fullWidth = sideBySide ? space.width - cover.width - 3 : space.width;
  const textWidth = textOnly ? Math.min(space.width, detailsMaxWidth) : fullWidth;
  const line = (text: string) => fit(text, textWidth);

  return (
    <box
      flexGrow={1}
      flexDirection={sideBySide ? "row" : "column"}
      // The tracklist takes the full height
      alignItems={textOnly || (sideBySide && props.segments.length === 0) ? "center" : "stretch"}
      justifyContent={centered ? "center" : "flex-start"}
      gap={sideBySide ? 3 : 1}
      paddingX={2}
      paddingY={1}
    >
      {cover.height > 0 && (
        // The text below shrinks, not the cover
        <box alignItems="center" flexShrink={0}>
          {props.cover(cover.width, cover.height)}
        </box>
      )}
      <box
        flexDirection="column"
        flexGrow={centered ? 0 : 1}
        flexShrink={1}
        // Without the cover the column takes the width of its text, so that it is centered
        maxWidth={textWidth}
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

/** In a DJ set, the actions of the selected track of the set come before the actions of the set */
export function NowPlayingScreen(props: { readonly app: ScreenApp }) {
  const app = props.app;
  const { player, backdrop, segments } = app;
  const toast = useToast();
  // `null` follows the track that plays
  const [selection, setSelection] = useState<number | null>(null);
  useEffect(() => setSelection(null), [player.current?.id]);
  const selected = selection ?? Math.max(0, app.currentSegment);

  const playSegment = (index: number) => {
    const segment = segments[index];
    if (segment === undefined) return;
    setSelection(index);
    if (segment.startMs === null) toast("notice", "The tracklist gives no time for this track");
    else player.seekTo(segment.startMs);
  };

  const segmentActions = () => {
    const segment = segments[selected];
    if (segment === undefined) return [];
    return [
      new Action({
        command: commands.playSegment,
        label: "Play from this track",
        run: () => playSegment(selected),
      }),
      ...app.itemActions(new SegmentItem({ segment })),
    ];
  };

  const itemCommands = useItemCommands(app, {
    item: () => {
      const current = player.current;
      if (current === undefined) return undefined;
      const { source, context } = current;
      return new SongItem({ source, context, play: () => {}, extra: [] });
    },
    title: "Now playing",
    before: segmentActions,
  });

  const selectSegment = (index: number) =>
    setSelection(Math.max(0, Math.min(segments.length - 1, index)));
  const segmentCommands: ReadonlyArray<readonly [Command, () => void]> =
    segments.length === 0
      ? []
      : [
          [commands.playSegment, () => playSegment(selected)],
          [commands.up, () => selectSegment(selected - 1)],
          [commands.down, () => selectSegment(selected + 1)],
          [commands.pageUp, () => selectSegment(selected - pageStep)],
          [commands.pageDown, () => selectSegment(selected + pageStep)],
          [commands.first, () => selectSegment(0)],
          [commands.last, () => selectSegment(segments.length - 1)],
        ];

  useScreenCommands(app, [
    ...segmentCommands,
    [commands.close, app.router.back],
    [commands.actions, itemCommands.openActions],
    ...backdrop.commands,
    ...itemCommands.keys,
  ]);

  return (
    <Backdrop
      style={backdrop.style}
      overlay={backdrop.overlay}
      preset={backdrop.preset}
      source={player.current?.source}
      artwork={app.artwork}
      playing={player.state === "playing"}
      tap={player.tap}
      positionMs={player.position}
      connection={app.client}
      serverUrl={app.serverUrl}
      delayMs={backdrop.delayMs}
      onPresetEnd={backdrop.nextPreset}
      onVideoFailure={backdrop.videoFailed}
    >
      {backdrop.overlay !== "none" && (
        <NowPlayingView
          entry={player.current}
          segments={segments}
          currentSegment={app.currentSegment}
          selectedSegment={selected}
          onSelectSegment={setSelection}
          onPlaySegment={playSegment}
          upNext={upNextOf(player)}
          overlay={backdrop.overlay}
          video={app.cover.video}
          cover={app.cover.render}
          width={app.width}
          height={app.bodyHeight}
        />
      )}
    </Backdrop>
  );
}
