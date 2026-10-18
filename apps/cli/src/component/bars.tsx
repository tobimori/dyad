import { formatTime } from "@dyad/client-runtime";
import { useState } from "react";

import { useTheme } from "../theme/theme.ts";

export function ProgressBar(props: {
  readonly positionMs: number;
  readonly durationMs: number | null;
  /** Positions in ms that get a tick, for example the tracks of a DJ set */
  readonly marks?: ReadonlyArray<number>;
  readonly onSeek: (ms: number) => void;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);

  const { durationMs } = props;
  const elapsed = formatTime(props.positionMs);
  const total = durationMs === null ? "--:--" : formatTime(durationMs);
  const fraction = durationMs === null ? 0 : Math.min(1, props.positionMs / durationMs);
  const filled = Math.round(width * fraction);
  const ticks = new Set(
    durationMs === null
      ? []
      : (props.marks ?? []).map((ms) => Math.floor((width * ms) / durationMs)),
  );
  const line = (from: number, to: number, plain: string, tick: string) =>
    Array.from({ length: Math.max(0, to - from) }, (_, index) =>
      ticks.has(from + index) ? tick : plain,
    ).join("");

  return (
    <box flexDirection="row" height={1} gap={1}>
      <text fg={theme.muted}>{elapsed}</text>
      <box
        flexGrow={1}
        flexBasis={0}
        overflow="hidden"
        onSizeChange={function () {
          setWidth(this.width);
        }}
        onMouseDown={function (event) {
          if (props.durationMs === null || this.width === 0) return;
          props.onSeek(((event.x - this.x) / this.width) * props.durationMs);
        }}
      >
        <text wrapMode="none">
          <span fg={theme.accent}>{line(0, filled, "━", "╋")}</span>
          <span fg={theme.faint}>{line(filled, width, "─", "┼")}</span>
        </text>
      </box>
      <text fg={theme.muted}>{total}</text>
    </box>
  );
}

const volumeLevels = "▁▂▃▄▅▆▇█";

export function VolumeBar(props: {
  readonly volume: number;
  readonly muted: boolean;
  readonly onChange: (volume: number) => void;
}) {
  const theme = useTheme();
  const levels = Math.round(props.volume * volumeLevels.length);

  return (
    <box flexDirection="row" height={1}>
      <box
        width={volumeLevels.length}
        onMouseDown={function (event) {
          props.onChange((event.x - this.x + 1) / volumeLevels.length);
        }}
      >
        <text wrapMode="none">
          <span fg={theme.accent}>{volumeLevels.slice(0, levels)}</span>
          <span fg={theme.faint}>{volumeLevels.slice(levels)}</span>
        </text>
      </box>
      <text fg={theme.muted}> {String(Math.round(props.volume * 100)).padStart(3)}%</text>
      {props.muted && <text fg={theme.error}> Muted</text>}
    </box>
  );
}
