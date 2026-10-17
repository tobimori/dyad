import { fit, formatDuration, sourceLabel, titleOf } from "./format.ts";
import type { QueueEntry } from "./queue.ts";
import type { Theme } from "./theme.ts";
import type { Artwork } from "./use-artwork.ts";

/** The current source with its cover, and the next entries of the queue */
export function NowPlaying(props: {
  readonly entry: QueueEntry | undefined;
  readonly upNext: ReadonlyArray<QueueEntry>;
  readonly artwork: Artwork | null;
  readonly width: number;
  readonly height: number;
  readonly theme: Theme;
}) {
  const theme = props.theme;
  const innerWidth = props.width - 4;
  // Terminal cells are about twice as high as wide. The text below the cover needs about 10 rows.
  const artHeight = Math.max(0, Math.min(Math.floor(innerWidth / 2), props.height - 12));
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
  const details = [sourceLabel(source), formatDuration(source.durationMs)]
    .filter((part) => part !== "")
    .join(" · ");

  return (
    <box
      width={props.width}
      flexDirection="column"
      backgroundColor={theme.panel}
      paddingX={2}
      paddingY={1}
    >
      {artHeight > 0 && (
        <box height={artHeight} marginBottom={1} justifyContent="center" alignItems="center">
          {props.artwork === null ? (
            <text fg={theme.faint}>♪</text>
          ) : (
            <image source={props.artwork.image} fit="fit" width={innerWidth} height={artHeight} />
          )}
        </box>
      )}
      <text fg={theme.text}>
        <strong>{line(titleOf(source))}</strong>
      </text>
      <text fg={theme.accent}>{line(source.artist ?? "Unknown artist")}</text>
      <text fg={theme.muted}>{line(source.album ?? "")}</text>
      <text fg={theme.faint}>{line(details)}</text>
      {props.upNext.length > 0 && (
        <box flexDirection="column" marginTop={1}>
          <text fg={theme.muted}>
            <strong>Up next</strong>
          </text>
          {props.upNext.map((entry) => (
            <text key={entry.key} fg={theme.muted}>
              {line(
                entry.source.artist === null
                  ? titleOf(entry.source)
                  : `${titleOf(entry.source)} · ${entry.source.artist}`,
              )}
            </text>
          ))}
        </box>
      )}
    </box>
  );
}
