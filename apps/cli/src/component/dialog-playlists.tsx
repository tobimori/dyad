import { providerName } from "@dyad/client-runtime";
import type { ServerAtoms, ServerConnection } from "@dyad/client-runtime";
import { PlaylistName } from "@dyad/domain";
import type { PlaylistSummary, RecordingId } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import type { InputRenderable } from "@opentui/core";
import { Effect, Schema } from "effect";
import type { Fiber } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { PlaylistItem, SegmentItem, SongItem } from "../context/action-items.ts";
import type { ActionApp, ActionItem } from "../context/action-items.ts";
import { commands, useCommands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";
import { useLibraryStatus } from "./library-notice.tsx";
import { counted } from "./row-list.tsx";

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

// A new playlist can also be a new playlist of a provider that gets the edits
function LinkDialog(props: {
  readonly providers: ReadonlyArray<{ readonly provider: string; readonly name: string }>;
  readonly onChoose: (provider: string | null) => void;
}) {
  const dialog = useDialog();
  const options = [
    new SelectOption({ value: "", title: "Only in Dyad", detail: "" }),
    ...props.providers.map(
      ({ provider, name }) =>
        new SelectOption({ value: provider, title: `Also in ${name}`, detail: "two-way" }),
    ),
  ];

  return (
    <Dialog title="Where does the playlist go?" width={dialogWidth}>
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={options.length}
        onChoose={(value) => {
          dialog.pop();
          props.onChoose(value === "" ? null : value);
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
  const playlists = AsyncResult.isSuccess(result) ? result.value : [];
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
  /** The replica of this device */
  readonly replica: typeof ServerConnection.Service;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const { names } = useLibraryStatus(props.atoms);
  const providersResult = useAtomValue(props.atoms.playlistProviders);
  const providers = AsyncResult.isSuccess(providersResult) ? providersResult.value : [];
  const replica = props.replica;

  const create = (
    entries: ReadonlyArray<{ readonly recordingId: RecordingId; readonly sourceId: string | null }>,
    initialName = "",
  ) => {
    const save = (name: string, provider: string | null) =>
      props.run(
        replica.createPlaylist({ name, entries, twoWayProvider: provider }).pipe(
          Effect.match({
            onSuccess: () =>
              toast(
                "notice",
                entries.length === 0 ? `Created ${name}` : `Added to the new playlist ${name}`,
              ),
            onFailure: () => toast("error", "Cannot create the playlist"),
          }),
        ),
      );
    dialog.push(
      <NameDialog
        title="New playlist"
        initial={initialName}
        onSubmit={(name) =>
          providers.length === 0
            ? save(name, null)
            : dialog.push(
                <LinkDialog providers={providers} onChoose={(provider) => save(name, provider)} />,
              )
        }
      />,
    );
  };

  return {
    create: () => create([]),
    /** For a DJ set whose tracklist has matched recordings */
    saveSet: (title: string, recordingIds: ReadonlyArray<RecordingId>) =>
      new Action({
        command: commands.saveSetAsPlaylist,
        label: `Save ${counted(recordingIds.length, "identified track")} as a playlist…`,
        run: () =>
          create(
            recordingIds.map((recordingId) => ({ recordingId, sourceId: null })),
            title.slice(0, 200),
          ),
      }),
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
                props.run(replica.addPlaylistEntries({ playlistId: playlist.id, entries }));
                toast("notice", `Added to ${playlist.name}`);
              }}
            />,
          ),
      }),
    /** Rename, unlink and delete */
    manage: (playlist: PlaylistSummary, onDelete: () => void) => {
      const provider = playlist.link === null ? null : providerName(names, playlist.link.provider);
      return [
        new Action({
          command: commands.renamePlaylist,
          label: "Rename the playlist…",
          run: () =>
            dialog.push(
              <NameDialog
                title="Rename the playlist"
                initial={playlist.name}
                onSubmit={(name) =>
                  props.run(replica.editPlaylist({ playlistId: playlist.id, name }))
                }
              />,
            ),
        }),
        ...(provider === null
          ? []
          : [
              new Action({
                command: commands.unlinkPlaylist,
                label: `Unlink from ${provider}…`,
                run: () =>
                  dialog.push(
                    <ConfirmDialog
                      title={`Stop the sync with ${provider}?`}
                      confirm="Unlink, keep the playlist"
                      onConfirm={() =>
                        props.run(replica.editPlaylist({ playlistId: playlist.id, unlink: true }))
                      }
                    />,
                  ),
              }),
            ]),
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
                  props.run(replica.editPlaylist({ playlistId: playlist.id, deleted: true }));
                  toast("notice", `Deleted ${playlist.name}`);
                }}
              />,
            ),
        }),
      ];
    },
  };
}

/** "Add to playlist" for songs and tracks of sets, and the edits of a playlist */
export function usePlaylistItemActions(app: ActionApp) {
  const playlists = usePlaylistActions({ atoms: app.atoms, replica: app.replica, run: app.run });
  return (item: ActionItem) => {
    if (item instanceof SongItem && item.source.recordingId !== null) {
      return [playlists.add([{ recordingId: item.source.recordingId, sourceId: item.source.id }])];
    }
    if (item instanceof SegmentItem && item.segment.recordingId !== null) {
      return [playlists.add([{ recordingId: item.segment.recordingId, sourceId: null }])];
    }
    if (item instanceof PlaylistItem) return playlists.manage(item.playlist, item.onDelete);
    return [];
  };
}
