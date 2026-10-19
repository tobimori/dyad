import { titleOf } from "@dyad/client-runtime";
import { RadioStart } from "@dyad/domain";
import type { SourceSummary } from "@dyad/domain";
import { Effect } from "effect";

import { ArtistItem, SongItem } from "../context/action-items.ts";
import type { ActionApp, ActionItem } from "../context/action-items.ts";
import { commands } from "../context/keymap.ts";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";

/** "Start radio" for a song and an artist. The seed plays first, then the songs after it. */
export function useRadioActions(app: ActionApp) {
  const toast = useToast();

  const start = (radio: typeof RadioStart.Type, label: string, seed: SourceSummary | null) => {
    const client = app.client;
    if (client === null) {
      toast("error", "Connect to the server to start a radio");
      return;
    }
    toast("notice", `Starting radio: ${label}`);
    app.run(
      client.radio({ start: radio }).pipe(
        Effect.match({
          onSuccess: (tracks) => {
            if (tracks.length === 0) {
              toast("notice", `No radio songs for ${label} yet`);
              return;
            }
            const reasons = Object.fromEntries(
              tracks.flatMap((track) =>
                track.reason === null ? [] : [[track.source.id, track.reason]],
              ),
            );
            const sources = [
              ...(seed === null ? [] : [seed]),
              ...tracks.map((track) => track.source),
            ];
            app.player.playList(sources, 0, "radio", reasons);
          },
          onFailure: () => toast("error", "Cannot start the radio. Try again."),
        }),
      ),
    );
  };

  return (item: ActionItem) => {
    if (item instanceof SongItem) {
      const source = item.source;
      return [
        new Action({
          command: commands.startRadio,
          label: "Start radio",
          run: () =>
            start(RadioStart.cases.Source.make({ sourceId: source.id }), titleOf(source), source),
        }),
      ];
    }
    if (item instanceof ArtistItem) {
      return [
        new Action({
          command: commands.artistRadio,
          label: `Start artist radio: ${item.name}`,
          run: () => start(RadioStart.cases.Artist.make({ name: item.name }), item.name, null),
        }),
      ];
    }
    return [];
  };
}
