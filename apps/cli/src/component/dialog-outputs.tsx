import { deviceOutputId } from "@dyad/client-runtime";
import type { SessionClient } from "@dyad/client-runtime";
import type { OutputId } from "@dyad/domain";
import type { BoxRenderable } from "@opentui/core";
import type { Effect, Fiber } from "effect";
import { useRef, useState } from "react";

import { commands, useCommands } from "../context/keymap.ts";
import { useSessionView } from "../playback/use-player.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";

const outputsWidth = 52;
const volumeStep = 0.05;

/** The outputs that can play the session. Choosing one moves the playback there. */
export function OutputsDialog(props: {
  readonly session: typeof SessionClient.Service;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly transfer: (outputId: OutputId) => void;
  readonly setVolume: (outputId: OutputId, volume: number) => void;
}) {
  const dialog = useDialog();
  const content = useRef<BoxRenderable | null>(null);
  const view = useSessionView(props.session, props.run);
  const [highlighted, setHighlighted] = useState<OutputId | null>(null);

  const active = view.playback.outputId;
  const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);
  const options = view.outputs.map(
    (output) =>
      new SelectOption({
        value: output.id,
        title: `${output.id === active ? "▶ " : ""}${output.name}${output.id === own ? " (this device)" : ""}`,
        detail: output.volume === null ? "" : `${Math.round(output.volume * 100)}%`,
      }),
  );

  const changeVolume = (direction: 1 | -1) => {
    const output = view.outputs.find((candidate) => candidate.id === highlighted);
    if (output?.volume == null) return;
    props.setVolume(output.id, output.volume + direction * volumeStep);
  };

  useCommands(
    [
      [commands.volumeUp, () => changeVolume(1)],
      [commands.volumeDown, () => changeVolume(-1)],
    ],
    { target: content, targetMode: "focus-within" },
  );

  const choose = (outputId: OutputId) => {
    dialog.pop();
    if (outputId !== active) props.transfer(outputId);
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
      </box>
    </Dialog>
  );
}
