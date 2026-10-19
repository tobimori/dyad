import { formatDuration, songLine, sourceLabel, titleOf } from "@dyad/client-runtime";
import type { ServerAtoms } from "@dyad/client-runtime";
import type { HeardInSet, RecordingId } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef } from "react";

import { SegmentItem, SongItem } from "../../context/action-items.ts";
import type { ActionApp, ActionItem } from "../../context/action-items.ts";
import { commands } from "../../context/keymap.ts";
import type { usePlayer } from "../../playback/use-player.ts";
import { useTheme } from "../../theme/theme.ts";
import { Dialog, useDialog } from "../../ui/dialog.tsx";
import { SelectList, SelectOption } from "../../ui/select-list.tsx";
import { Action } from "../../component/dialog-actions.tsx";
import { usePlaylistActions } from "../playlists/dialog-playlists.tsx";
import { counted } from "../../component/row-list.tsx";

const dialogWidth = 72;

function HeardInSetsDialog(props: {
  readonly atoms: ServerAtoms;
  readonly recordingId: RecordingId;
  readonly onPlay: (heard: HeardInSet) => void;
}) {
  const theme = useTheme();
  const dialog = useDialog();
  const result = useAtomValue(props.atoms.heardInSets(props.recordingId));
  const sets = AsyncResult.isSuccess(result) ? result.value : [];

  const options = sets.map(
    (heard, index) =>
      new SelectOption({
        value: index,
        title: songLine(heard.set),
        detail: [heard.set.series, sourceLabel(heard.set), formatDuration(heard.startMs)]
          .filter((part) => part !== null && part !== "")
          .join(" · "),
      }),
  );

  const empty = AsyncResult.match(result, {
    onInitial: () => "Loading…",
    onFailure: () => "Cannot load the sets. Try again.",
    onSuccess: () => "No set that you can play has this track yet",
  });

  return (
    <Dialog
      title={sets.length === 0 ? "Heard in sets" : `Heard in ${counted(sets.length, "set")}`}
      width={dialogWidth}
    >
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={12}
        empty={empty}
        onChoose={(index) => {
          const heard = sets[index];
          if (heard === undefined) return;
          dialog.pop();
          props.onPlay(heard);
        }}
      />
      {options.length > 0 && <text fg={theme.faint}>⏎ play from this track · esc close</text>}
    </Dialog>
  );
}

/** "Heard in sets" for a recording. A chosen set plays from the first time that it plays it. */
export function useHeardInSets(props: {
  readonly atoms: ServerAtoms;
  readonly player: ReturnType<typeof usePlayer>;
}) {
  const dialog = useDialog();
  // `Play` has no start position, so the seek waits until the set is the current entry
  const pendingSeek = useRef<{ readonly sourceId: string; readonly startMs: number } | null>(null);
  const current = props.player.current;

  useEffect(() => {
    const pending = pendingSeek.current;
    if (pending === null || current?.source.id !== pending.sourceId) return;
    pendingSeek.current = null;
    props.player.seekTo(pending.startMs);
  }, [current?.id]);

  const play = (heard: HeardInSet) => {
    pendingSeek.current =
      heard.startMs === null ? null : { sourceId: heard.set.id, startMs: heard.startMs };
    props.player.playList([heard.set], 0, "library");
  };

  return (recordingId: RecordingId | null) =>
    recordingId === null
      ? []
      : [
          new Action({
            command: commands.heardInSets,
            label: "Heard in sets…",
            run: () =>
              dialog.push(
                <HeardInSetsDialog atoms={props.atoms} recordingId={recordingId} onPlay={play} />,
              ),
          }),
        ];
}

/**
 * "Heard in sets" for a song and a track of a set. The set that plays saves its identified tracks
 * as a playlist instead, unless its screen gives that action.
 */
export function useSetActions(app: ActionApp) {
  const heardInSets = useHeardInSets({ atoms: app.atoms, player: app.player });
  const playlists = usePlaylistActions({ atoms: app.atoms, replica: app.replica, run: app.run });
  return (item: ActionItem) => {
    if (item instanceof SegmentItem) return heardInSets(item.segment.recordingId);
    if (!(item instanceof SongItem)) return [];

    const source = item.source;
    const playingSet = source.id === app.player.current?.source.id && app.segments.length > 0;
    if (!playingSet) return heardInSets(source.recordingId);
    const identified = [...new Set(app.segments.flatMap((segment) => segment.recordingId ?? []))];
    const savesSet = item.extra.some((action) => action.command === commands.saveSetAsPlaylist);
    return identified.length > 0 && !savesSet
      ? [playlists.saveSet(titleOf(source), identified)]
      : [];
  };
}
