import { deviceOutputId } from "@dyad/client-runtime";
import type { SessionClient } from "@dyad/client-runtime";
import type { OutputId } from "@dyad/domain";
import type { Effect, Fiber } from "effect";

import { useSessionView } from "../playback/use-player.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";

const roomsWidth = 60;

const stateTexts = { playing: "▶", paused: "Paused", stopped: "" };

/** The rooms of the server. Choosing one shows and controls it; its audio stays where it is. */
export function RoomsDialog(props: {
  readonly session: typeof SessionClient.Service;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly select: (room: OutputId) => void;
}) {
  const dialog = useDialog();
  const view = useSessionView(props.session, props.run);
  const own = view.deviceId === null ? null : deviceOutputId(view.deviceId);

  const online = (room: OutputId) => view.outputs.some((output) => output.id === room);
  // An offline room without a song is noise, for example the AirPlay side of a Sonos
  const shown = view.rooms.filter(
    (room) => room.id === own || room.current !== null || online(room.id),
  );
  const options = shown.map(
    (room) =>
      new SelectOption<OutputId | null>({
        value: room.id,
        title: `${room.name}${room.id === own ? " (this device)" : ""}`,
        detail: [
          stateTexts[room.playback.state],
          room.playback.state === "stopped" ? "" : (room.current?.title ?? ""),
          room.playback.outputId === null && room.playback.state !== "stopped" ? "No output" : "",
          online(room.id) ? "" : "Offline",
        ]
          .filter((text) => text !== "")
          .join(" · "),
      }),
  );

  return (
    <Dialog title="Rooms" width={roomsWidth}>
      <SelectList
        options={options}
        width={roomsWidth - 4}
        rows={12}
        empty="The server has no rooms yet"
        onChoose={(room) => {
          dialog.pop();
          if (room !== null) props.select(room);
        }}
        initial={view.room}
      />
    </Dialog>
  );
}
