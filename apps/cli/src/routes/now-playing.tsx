import { formatDuration, songLine, sourceLabel, titleOf } from "@dyad/client-runtime";
import type { QueueEntry } from "@dyad/client-runtime";

import { ProgressBar } from "../component/bars.tsx";
import { Cover } from "../component/cover.tsx";
import type { Artwork } from "../component/use-artwork.ts";
import { useTheme } from "../theme/theme.ts";
import { fit } from "../ui/format.ts";

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
        <text key={entry.key} fg={theme.muted} wrapMode="none" flexShrink={0}>
          {fit(songLine(entry.source), props.width)}
        </text>
      ))}
    </box>
  );
}

export function NowPlayingPanel(props: {
  readonly entry: QueueEntry | undefined;
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
      <UpNext entries={props.upNext} width={innerWidth} />
    </box>
  );
}

// Below this width, the cover goes above the text
const sideBySideMinWidth = 64;

export function NowPlayingView(props: {
  readonly entry: QueueEntry | undefined;
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
      alignItems={sideBySide ? "center" : "stretch"}
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
        <box marginTop={1} flexShrink={0}>
          <ProgressBar
            positionMs={props.positionMs}
            durationMs={props.durationMs}
            onSeek={props.onSeek}
          />
        </box>
        <UpNext entries={props.upNext} width={textWidth} />
      </box>
    </box>
  );
}
