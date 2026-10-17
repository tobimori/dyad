import { Fragment } from "react";

import { formatTime, titleOf } from "./format.ts";
import type { QueueEntry, RepeatMode } from "./queue.ts";
import type { Theme } from "./theme.ts";

const volumeLevels = "▁▂▃▄▅▆▇█";

const stateIcons = { stopped: "■", loading: "…", playing: "▶", paused: "⏸" };

/** What plays, the progress, the playback modes and the keys for what has focus */
export function Footer(props: {
  readonly entry: QueueEntry | undefined;
  readonly state: keyof typeof stateIcons;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly volume: number;
  readonly shuffle: boolean;
  readonly repeat: typeof RepeatMode.Type;
  readonly message: string | null;
  readonly hints: ReadonlyArray<readonly [string, string]>;
  readonly width: number;
  readonly theme: Theme;
}) {
  const theme = props.theme;

  const elapsed = formatTime(props.positionMs);
  const total = props.durationMs === null ? "--:--" : formatTime(props.durationMs);
  const barWidth = Math.max(0, props.width - elapsed.length - total.length - 4);
  const fraction = props.durationMs === null ? 0 : Math.min(1, props.positionMs / props.durationMs);
  const filled = Math.round(barWidth * fraction);

  const levels = Math.round(props.volume * volumeLevels.length);
  const modeColor = (on: boolean) => (on ? theme.accent : theme.faint);

  return (
    <box flexDirection="column" height={3} paddingX={1} backgroundColor={theme.panel}>
      <box flexDirection="row" height={1} gap={2}>
        <text flexGrow={1} flexBasis={0} wrapMode="none">
          <span fg={theme.accent}>{stateIcons[props.state]} </span>
          {props.entry === undefined ? (
            <span fg={theme.muted}>{props.message ?? "Nothing is playing"}</span>
          ) : (
            <>
              <strong fg={theme.text}>{titleOf(props.entry.source)}</strong>
              <span fg={theme.muted}>
                {props.entry.source.artist === null ? "" : `  ${props.entry.source.artist}`}
              </span>
              <span fg={theme.accent}>{props.message === null ? "" : `  ${props.message}`}</span>
            </>
          )}
        </text>
        <text>
          <span fg={modeColor(props.shuffle)}>⤨ shuffle </span>
          <span fg={modeColor(props.repeat !== "off")}>{`↻ ${props.repeat} `}</span>
          <span fg={theme.accent}>{volumeLevels.slice(0, levels)}</span>
          <span fg={theme.faint}>{volumeLevels.slice(levels)}</span>
          <span fg={theme.muted}> {String(Math.round(props.volume * 100)).padStart(3)}%</span>
        </text>
      </box>
      <text wrapMode="none">
        <span fg={theme.muted}>{elapsed} </span>
        <span fg={theme.accent}>{"━".repeat(filled)}</span>
        <span fg={theme.faint}>{"─".repeat(barWidth - filled)}</span>
        <span fg={theme.muted}> {total}</span>
      </text>
      <text wrapMode="none">
        {props.hints.map(([key, label]) => (
          <Fragment key={key}>
            <span fg={theme.accent}>{key}</span>
            <span fg={theme.muted}>{` ${label}   `}</span>
          </Fragment>
        ))}
      </text>
    </box>
  );
}
