import { titleOf } from "@dyad/client-runtime";
import type { QueueEntry } from "@dyad/client-runtime";
import type { RepeatMode } from "@dyad/domain";
import { Fragment } from "react";

import { ProgressBar, VolumeBar } from "./bars.tsx";
import { useHints } from "../context/keymap.ts";
import { Cover } from "./cover.tsx";
import { useTheme } from "../theme/theme.ts";
import type { Artwork } from "./use-artwork.ts";

const stateIcons = { stopped: "■", loading: "…", playing: "▶", paused: "⏸" };

export function Footer(props: {
  readonly entry: QueueEntry | undefined;
  readonly state: keyof typeof stateIcons;
  readonly positionMs: number;
  readonly durationMs: number | null;
  readonly volume: number;
  readonly shuffle: boolean;
  readonly repeat: typeof RepeatMode.Type;
  readonly message: string | null;
  readonly artwork: Artwork | null;
  /** `false` when the cover shows elsewhere on the screen */
  readonly showCover: boolean;
  readonly onOpen: () => void;
  readonly onSeek: (ms: number) => void;
  readonly onVolume: (volume: number) => void;
}) {
  const theme = useTheme();
  const hints = useHints();
  const modeColor = (on: boolean) => (on ? theme.accent : theme.faint);

  return (
    <box flexDirection="row" height={3} paddingX={1} gap={1} backgroundColor={theme.panel}>
      {props.showCover && props.entry !== undefined && (
        <box onMouseDown={props.onOpen}>
          <Cover artwork={props.artwork} width={6} height={3} />
        </box>
      )}
      <box flexDirection="column" flexGrow={1}>
        <box flexDirection="row" height={1} gap={2}>
          <text flexGrow={1} flexBasis={0} wrapMode="none" onMouseDown={props.onOpen}>
            <span fg={theme.accent}>{stateIcons[props.state]} </span>
            {props.entry === undefined ? (
              <span fg={theme.muted}>Nothing is playing</span>
            ) : (
              <>
                <strong fg={theme.text}>{titleOf(props.entry.source)}</strong>
                <span fg={theme.muted}>
                  {props.entry.source.artist === null ? "" : `  ${props.entry.source.artist}`}
                </span>
              </>
            )}
            <span fg={theme.error}>{props.message === null ? "" : `  ${props.message}`}</span>
          </text>
          <text>
            <span fg={modeColor(props.shuffle)}>⤨ shuffle </span>
            <span fg={modeColor(props.repeat !== "off")}>{`↻ ${props.repeat}`}</span>
          </text>
          <VolumeBar volume={props.volume} onChange={props.onVolume} />
        </box>
        <ProgressBar
          positionMs={props.positionMs}
          durationMs={props.durationMs}
          onSeek={props.onSeek}
        />
        <text wrapMode="none">
          {hints.map(([key, label]) => (
            <Fragment key={label}>
              <span fg={theme.accent}>{key}</span>
              <span fg={theme.muted}>{` ${label}   `}</span>
            </Fragment>
          ))}
        </text>
      </box>
    </box>
  );
}
