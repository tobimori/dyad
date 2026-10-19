import { formatTotalDuration, providerName } from "@dyad/client-runtime";
import type { ServerAtoms } from "@dyad/client-runtime";
import { PlaylistNotFound } from "@dyad/domain";
import type { PlaylistEntry, PlaylistSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Schema } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { Action } from "../../component/dialog-actions.tsx";
import { useLibraryStatus } from "../../component/library-notice.tsx";
import { useListScreen } from "../../component/list-screen.tsx";
import { ListItem, TrackList, entryItems, playsSource } from "../../component/track-list.tsx";
import { commands } from "../../context/keymap.ts";
import type { Command } from "../../context/keymap.ts";
import type { Route } from "../../context/router.ts";
import { useReload } from "../../context/screen-app.ts";
import type { ScreenApp } from "../../context/screen-app.ts";
import { useTheme } from "../../theme/theme.ts";
import { listActions } from "./page-view.tsx";

function PlaylistHeader(props: {
  readonly atoms: ServerAtoms;
  readonly route: typeof Route.cases.Playlist.Type;
  readonly playlist: PlaylistSummary | undefined;
  readonly entries: ReadonlyArray<PlaylistEntry>;
}) {
  const theme = useTheme();
  const { names } = useLibraryStatus(props.atoms);
  const playlist = props.playlist;

  const link = playlist?.link ?? null;
  const provider = link === null ? null : providerName(names, link.provider);
  const linkState = playlist?.linkState ?? null;
  const linkText = () => {
    if (provider === null) return "";
    if (link?.direction === "import") {
      return `Gets the changes from ${provider}. Edits here stay in Dyad.`;
    }
    if (linkState?.error != null) return linkState.error;
    if (link?.remoteId === null) return `Creates the playlist in ${provider}…`;
    if (linkState?.differs === true) {
      return `Differs from ${provider}: it cannot make some edits`;
    }
    return `Syncs with ${provider} both ways`;
  };
  const totalMs = props.entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);
  const details = [
    provider === null ? "Playlist" : `${provider} playlist`,
    totalMs === 0 ? "" : formatTotalDuration(totalMs),
  ];

  return (
    <box flexDirection="column" height={3} marginTop={1} marginBottom={1} flexShrink={0}>
      <text wrapMode="none" fg={theme.text}>
        <strong>{playlist?.name ?? props.route.hint}</strong>
      </text>
      <text wrapMode="none" fg={theme.muted}>
        {details.filter((detail) => detail !== "").join(" · ")}
      </text>
      <text wrapMode="none" fg={theme.faint}>
        {linkText()}
      </text>
    </box>
  );
}

const isNotFound = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) &&
  Option.exists(Cause.findErrorOption(result.cause), Schema.is(PlaylistNotFound));

/** A playlist can have a song twice, so the keys of its items are entry IDs */
export function PlaylistScreen(props: {
  readonly app: ScreenApp;
  readonly route: typeof Route.cases.Playlist.Type;
}) {
  const { app, route } = props;
  const atom = app.atoms.playlistEntries(route.id);
  const result = useAtomValue(atom);
  useReload(app, useAtomRefresh(atom));
  const items = useMemo(
    () =>
      entryItems(
        AsyncResult.isSuccess(result) ? result.value : [],
        "playlist",
        (entry) => entry.entryId,
        // The provider has no source of the song, so it stays out of the provider playlist
        (entry) => (entry.dyadOnly ? "Only in Dyad" : undefined),
      ),
    [result],
  );
  const summaries = useAtomValue(app.atoms.playlists);
  const playlist = AsyncResult.isSuccess(summaries)
    ? summaries.value.find((candidate) => candidate.id === route.id)
    : undefined;

  const removeEntry = (selected: number) => {
    const entry = items[selected];
    if (entry === undefined) return;
    const neighbor = items[selected + 1] ?? items[selected - 1];
    if (neighbor !== undefined) app.router.select(neighbor.key);
    app.run(app.replica.removePlaylistEntry({ entryId: entry.key }));
  };
  const moveEntry = (selected: number, direction: 1 | -1) => {
    const entry = items[selected];
    if (entry === undefined) return;
    app.run(app.replica.movePlaylistEntry({ playlistId: route.id, entryId: entry.key, direction }));
  };
  const manage = () =>
    playlist === undefined ? [] : app.playlistActions.manage(playlist, app.router.back);

  const keys: ReadonlyArray<readonly [Command, (selected: number) => void]> =
    playlist === undefined
      ? []
      : [
          [commands.removeEntry, removeEntry],
          [commands.moveEntryUp, (selected) => moveEntry(selected, -1)],
          [commands.moveEntryDown, (selected) => moveEntry(selected, 1)],
          [
            commands.renamePlaylist,
            () =>
              manage()
                .find((action) => action.command === commands.renamePlaylist)
                ?.run(),
          ],
        ];

  const list = useListScreen(app, {
    title: route.hint,
    items,
    keys,
    actions: () => {
      const sources = items.flatMap((item) => (item instanceof ListItem ? [item.source] : []));
      const removal =
        playlist === undefined
          ? []
          : [
              new Action({
                command: commands.removeEntry,
                label: "Remove from the playlist",
                run: () => removeEntry(list.selected),
              }),
            ];
      const download = { kind: "playlist" as const, id: route.id, title: route.hint };
      return [...removal, ...listActions(app, sources, "playlist", download), ...manage()];
    },
  });

  const empty = () => {
    if (isNotFound(result)) {
      return "This playlist does not exist anymore. Press esc to go back.";
    }
    if (AsyncResult.isFailure(result)) return "Cannot load the playlist. Press r to try again.";
    if (AsyncResult.isInitial(result)) return "Loading…";
    return "This playlist is empty";
  };

  return (
    <TrackList
      title={app.breadcrumb}
      header={
        <PlaylistHeader
          atoms={app.atoms}
          route={route}
          playlist={playlist}
          entries={AsyncResult.isSuccess(result) ? result.value : []}
        />
      }
      items={items}
      selected={list.selected}
      playing={playsSource(app.player.current?.source.id)}
      historyRows={0}
      empty={empty()}
      onSelect={list.select}
      onActivate={list.activate}
    />
  );
}
