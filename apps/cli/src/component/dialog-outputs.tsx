import { deviceOutputId } from "@dyad/client-runtime";
import type { SessionClient } from "@dyad/client-runtime";
import { DjStyle, SessionCommand } from "@dyad/domain";
import type { OutputId } from "@dyad/domain";
import type { BoxRenderable } from "@opentui/core";
import { Effect } from "effect";
import type { Fiber } from "effect";
import { useRef, useState } from "react";

import { commands, useCommands } from "../context/keymap.ts";
import { useSessionView } from "../playback/use-player.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";

const outputsWidth = 52;
const volumeStep = 0.05;
const crossfadeOnSeconds = 6;
// Off, then each style
const djStyles = [null, ...DjStyle.literals];

/** The outputs. Choosing one moves the queue into its room; the group key adds it to this room. */
export function OutputsDialog(props: {
  readonly session: typeof SessionClient.Service;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly transfer: (room: OutputId) => void;
  readonly group: (members: ReadonlyArray<OutputId>) => void;
  readonly setVolume: (outputId: OutputId, volume: number) => void;
}) {
  const dialog = useDialog();
  const theme = useTheme();
  const content = useRef<BoxRenderable | null>(null);
  const view = useSessionView(props.session, props.run);
  const [highlighted, setHighlighted] = useState<OutputId | null>(null);

  const room = view.room;
  const group = view.playback.group;
  const members = view.playback.outputId === null ? group : [view.playback.outputId, ...group];
  const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
  const options = view.outputs.map(
    (output) =>
      new SelectOption({
        value: output.id,
        title: `${members.includes(output.id) ? "▶ " : ""}${output.name}${output.id === own ? " (this device)" : ""}`,
        detail: [
          output.groupable ? "sync" : "no sync",
          output.muted ? "Muted" : "",
          output.volume === null ? "" : `${Math.round(output.volume * 100)}%`,
        ]
          .join(" ")
          .trim(),
      }),
  );

  const changeVolume = (direction: 1 | -1) => {
    const output = view.outputs.find((candidate) => candidate.id === highlighted);
    if (output?.volume == null) return;
    props.setVolume(output.id, output.volume + direction * volumeStep);
  };

  // Only groupable outputs play in sync, so the group keeps only those
  const toggleGroup = () => {
    const output = view.outputs.find((candidate) => candidate.id === highlighted);
    if (output?.groupable !== true || output.id === room) return;
    const groupable = group.filter((id) =>
      view.outputs.some((candidate) => candidate.id === id && candidate.groupable),
    );
    props.group(
      groupable.includes(output.id)
        ? groupable.filter((id) => id !== output.id)
        : [...groupable, output.id],
    );
  };

  const { crossfadeSeconds, djStyle } = view.playback;
  const setTransitions = (transitions: {
    readonly crossfadeSeconds: number;
    readonly djStyle: typeof DjStyle.Type | null;
  }) =>
    props.run(
      props.session.send(SessionCommand.cases.SetTransitions.make(transitions)).pipe(Effect.ignore),
    );

  useCommands(
    [
      [commands.volumeUp, () => changeVolume(1)],
      [commands.volumeDown, () => changeVolume(-1)],
      [commands.groupOutput, toggleGroup],
      [
        commands.crossfade,
        () =>
          setTransitions({
            crossfadeSeconds: crossfadeSeconds > 0 ? 0 : crossfadeOnSeconds,
            djStyle,
          }),
      ],
      [
        commands.djMode,
        () =>
          setTransitions({
            crossfadeSeconds,
            djStyle: djStyles[(djStyles.indexOf(djStyle) + 1) % djStyles.length] ?? null,
          }),
      ],
    ],
    { target: content, targetMode: "focus-within" },
  );

  const choose = (outputId: OutputId) => {
    dialog.pop();
    // Choosing the room's own output ends its group
    if (outputId !== room) props.transfer(outputId);
    else if (group.length > 0) props.group([]);
  };

  return (
    <Dialog title="Play on" width={outputsWidth}>
      <box ref={content} flexDirection="column">
        <SelectList
          options={options}
          width={outputsWidth - 4}
          rows={12}
          empty="No output is online. Start dyad on a device that plays."
          onChoose={choose}
          onHighlight={setHighlighted}
        />
        <text fg={theme.muted}>
          {`Crossfade ${crossfadeSeconds > 0 ? `${crossfadeSeconds} s` : "off"} · DJ mode ${djStyle ?? "off"}`}
        </text>
      </box>
    </Dialog>
  );
}
