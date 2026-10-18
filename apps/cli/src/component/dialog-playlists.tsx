import type { Replica, ServerAtoms } from "@dyad/client-runtime";
import { PlaylistName } from "@dyad/domain";
import type { PlaylistSummary, RecordingId } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import type { InputRenderable } from "@opentui/core";
import { Effect, Schema } from "effect";
import type { Fiber } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { commands, useCommands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";

const dialogWidth = 56;
const newPlaylist = "new";

function NameDialog(props: {
  readonly title: string;
  readonly initial: string;
  readonly onSubmit: (name: string) => void;
}) {
  const theme = useTheme();
  const dialog = useDialog();
  const input = useRef<InputRenderable | null>(null);
  const [name, setName] = useState(props.initial);
  const valid = Schema.is(PlaylistName)(name.trim());

  const submit = () => {
    if (!valid) return;
    dialog.pop();
    props.onSubmit(name.trim());
  };

  useCommands([[commands.submitInput, submit]], { target: input, targetMode: "focus" });
  useEffect(() => {
    input.current?.focus();
  }, []);

  return (
    <Dialog title={props.title} width={dialogWidth}>
      <box flexDirection="row" height={1}>
        <text width={2} fg={theme.accent}>
          ›
        </text>
        <input
          ref={input}
          flexGrow={1}
          value={name}
          placeholder="Name"
          maxLength={200}
          backgroundColor={theme.panel}
          focusedBackgroundColor={theme.selection}
          textColor={theme.text}
          focusedTextColor={theme.text}
          placeholderColor={theme.faint}
          cursorColor={theme.accent}
          onInput={setName}
        />
      </box>
      <text fg={theme.faint}>{valid ? "⏎ save · esc cancel" : "Type a name"}</text>
    </Dialog>
  );
}

function ConfirmDialog(props: {
  readonly title: string;
  readonly confirm: string;
  readonly onConfirm: () => void;
}) {
  const dialog = useDialog();
  const options = [
    new SelectOption({ value: "cancel", title: "Cancel", detail: "" }),
    new SelectOption({ value: "confirm", title: props.confirm, detail: "" }),
  ];

  return (
    <Dialog title={props.title} width={dialogWidth}>
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={2}
        onChoose={(value) => {
          dialog.pop();
          if (value === "confirm") props.onConfirm();
        }}
      />
    </Dialog>
  );
}

function PickerDialog(props: {
  readonly atoms: ServerAtoms;
  readonly onChoose: (playlist: PlaylistSummary) => void;
  readonly onNew: () => void;
}) {
  const dialog = useDialog();
  const result = useAtomValue(props.atoms.playlists);
  const playlists = AsyncResult.isSuccess(result)
    ? result.value.filter((playlist) => !playlist.readOnly)
    : [];
  const options = [
    new SelectOption({ value: newPlaylist, title: "New playlist…", detail: "" }),
    ...playlists.map(
      (playlist) =>
        new SelectOption({
          value: playlist.id,
          title: playlist.name,
          detail: String(playlist.entryCount),
        }),
    ),
  ];

  const choose = (id: string) => {
    dialog.pop();
    const playlist = playlists.find((candidate) => candidate.id === id);
    if (id === newPlaylist) props.onNew();
    else if (playlist !== undefined) props.onChoose(playlist);
  };

  return (
    <Dialog title="Add to playlist" width={dialogWidth}>
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={12}
        filter="Filter"
        onChoose={choose}
      />
    </Dialog>
  );
}

/** The dialogs of the playlist edits, as actions */
export function usePlaylistActions(props: {
  readonly atoms: ServerAtoms;
  readonly edits: (typeof Replica.Service)["playlists"];
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const edits = props.edits;

  const create = (
    entries: ReadonlyArray<{ readonly recordingId: RecordingId; readonly sourceId: string | null }>,
  ) =>
    dialog.push(
      <NameDialog
        title="New playlist"
        initial=""
        onSubmit={(name) =>
          props.run(
            edits.create(name, entries).pipe(
              Effect.match({
                onSuccess: () =>
                  toast(
                    "notice",
                    entries.length === 0 ? `Created ${name}` : `Added to the new playlist ${name}`,
                  ),
                onFailure: () =>
                  toast("error", "Connect to the server once before you create a playlist"),
              }),
            ),
          )
        }
      />,
    );

  return {
    create: () => create([]),
    /** For a track that has a recording */
    add: (
      entries: ReadonlyArray<{
        readonly recordingId: RecordingId;
        readonly sourceId: string | null;
      }>,
    ) =>
      new Action({
        command: commands.addToPlaylist,
        label: "Add to playlist…",
        run: () =>
          dialog.push(
            <PickerDialog
              atoms={props.atoms}
              onNew={() => create(entries)}
              onChoose={(playlist) => {
                props.run(edits.add(playlist.id, entries));
                toast("notice", `Added to ${playlist.name}`);
              }}
            />,
          ),
      }),
    /** Rename and delete. Imported playlists have none. */
    manage: (playlist: PlaylistSummary, onDelete: () => void) =>
      playlist.readOnly
        ? []
        : [
            new Action({
              command: commands.renamePlaylist,
              label: "Rename the playlist…",
              run: () =>
                dialog.push(
                  <NameDialog
                    title="Rename the playlist"
                    initial={playlist.name}
                    onSubmit={(name) => props.run(edits.rename(playlist.id, name))}
                  />,
                ),
            }),
            new Action({
              command: commands.deletePlaylist,
              label: "Delete the playlist…",
              run: () =>
                dialog.push(
                  <ConfirmDialog
                    title={`Delete ${playlist.name}?`}
                    confirm="Delete"
                    onConfirm={() => {
                      onDelete();
                      props.run(edits.delete(playlist.id));
                      toast("notice", `Deleted ${playlist.name}`);
                    }}
                  />,
                ),
            }),
          ],
  };
}
