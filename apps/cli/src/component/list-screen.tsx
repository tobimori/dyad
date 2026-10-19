import { songLine, titleOf } from "@dyad/client-runtime";

import { AlbumItem, ArtistItem, PlaylistItem, SongItem } from "../context/action-items.ts";
import type { ActionItem } from "../context/action-items.ts";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import { useScreenCommands } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";
import { useDialog } from "../ui/dialog.tsx";
import { useToast } from "../ui/toast.tsx";
import { ActionsDialog } from "./dialog-actions.tsx";
import type { Action } from "./dialog-actions.tsx";
import { AlbumRow, ArtistRow, PlaylistRow, TrackRow } from "./row-list.tsx";
import type { SelectableRow } from "./row-list.tsx";
import { ListItem, UnavailableItem } from "./track-list.tsx";
import type { TrackItem } from "./track-list.tsx";

const pageStep = 10;

/** The item actions that have a key of their own */
const actionKeys = [
  commands.playNext,
  commands.addToQueue,
  commands.addToPlaylist,
  commands.saveToLibrary,
  commands.favorite,
];

const currentSong = (app: ScreenApp) => {
  const current = app.player.current;
  if (current === undefined) return undefined;
  const { source, context } = current;
  return new SongItem({ source, context, play: () => {}, extra: [] });
};

/** The actions dialog, the action keys and the video of one item, or of the song that plays */
export function useItemCommands(
  app: ScreenApp,
  target: {
    readonly item: () => ActionItem | undefined;
    readonly title: string;
    /** Before the actions of the item */
    readonly before?: (() => ReadonlyArray<Action>) | undefined;
    /** After the actions of the item */
    readonly after?: (() => ReadonlyArray<Action>) | undefined;
  },
) {
  const dialog = useDialog();
  const toast = useToast();

  const itemActions = () => {
    const item = target.item();
    return item === undefined ? [] : app.itemActions(item);
  };

  const titleOfItem = () => {
    const item = target.item();
    if (item instanceof SongItem) return songLine(item.source);
    if (item instanceof AlbumItem) return item.album.title;
    if (item instanceof ArtistItem) return item.name;
    if (item instanceof PlaylistItem) return item.playlist.name;
    return target.title;
  };

  const openActions = () => {
    const actions = [...(target.before?.() ?? []), ...itemActions(), ...(target.after?.() ?? [])];
    if (actions.length === 0) return;
    dialog.push(<ActionsDialog title={titleOfItem()} actions={actions} />);
  };

  const watchVideo = () => {
    const item = target.item();
    const song = item instanceof SongItem ? item : currentSong(app);
    if (song === undefined) toast("notice", "Nothing is playing");
    else app.watchVideo(song);
  };

  const runAction = (command: Command) =>
    itemActions()
      .find((action) => action.command === command)
      ?.run();

  return {
    openActions,
    /** The action keys and the video key */
    keys: [
      ...actionKeys.map((command) => [command, () => runAction(command)] as const),
      [commands.watchVideo, watchVideo] as const,
    ],
  };
}

/**
 * The cursor, `return` and the item keys of a list screen. The cursor stays on its item per route,
 * also after back navigation.
 */
export function useListScreen(
  app: ScreenApp,
  list: {
    readonly title: string;
    readonly items: ReadonlyArray<TrackItem | SelectableRow>;
    /** Plays the track item at `index`. Without it, the list plays from that item. */
    readonly play?: ((index: number) => void) | undefined;
    /** Keys before the list keys. The handler gets the selected index. */
    readonly keys?: ReadonlyArray<readonly [Command, (selected: number) => void]> | undefined;
    /** The screen's actions of the song at `index`, or of the song that plays */
    readonly songActions?: ((index: number | null) => ReadonlyArray<Action>) | undefined;
    /** The screen's actions after the actions of the item */
    readonly actions?: (() => ReadonlyArray<Action>) | undefined;
  },
) {
  const toast = useToast();
  const { router, player } = app;
  const items = list.items;

  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.key === router.selected()),
  );
  const selectedItem = items[selectedIndex];

  const select = (index: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, index))];
    if (item !== undefined) router.select(item.key);
  };

  const playRow = (row: TrackRow) => {
    const index = row.section.findIndex((source) => source.id === row.track.source.id);
    if (!row.track.playable || index === -1) {
      toast("notice", `${titleOf(row.track.source)} cannot play`);
      return;
    }
    player.playList(row.section, index, row.context);
  };

  const activate = (index: number) => {
    const item = items[index];
    if (item instanceof ListItem && list.play !== undefined) {
      list.play(index);
      return;
    }
    if (item instanceof ListItem) {
      const tracks = items.filter((entry) => entry instanceof ListItem);
      player.playList(
        tracks.map((entry) => entry.source),
        tracks.indexOf(item),
        item.context,
      );
      return;
    }
    if (item instanceof UnavailableItem) {
      toast("notice", `${titleOf(item.entry)} cannot play: ${item.label}`);
    }
    if (item instanceof TrackRow) playRow(item);
    if (item instanceof AlbumRow) {
      app.openAlbum(item.album.ref, item.album.title, item.album.artistRef);
    }
    if (item instanceof ArtistRow) app.openArtist(item.artist.ref, item.artist.name);
    if (item instanceof PlaylistRow) app.openPlaylist(item.playlist.id, item.playlist.name);
  };

  // In an empty list, the actions are for the song that plays
  const target = () => {
    const play = () => activate(selectedIndex);
    if (selectedItem instanceof ListItem) {
      const { source, context } = selectedItem;
      const extra = list.songActions?.(selectedIndex) ?? [];
      return new SongItem({ source, context, play, extra });
    }
    if (selectedItem instanceof TrackRow) {
      const { source } = selectedItem.track;
      return new SongItem({ source, context: selectedItem.context, play, extra: [] });
    }
    if (selectedItem instanceof AlbumRow) return new AlbumItem({ album: selectedItem.album });
    if (selectedItem instanceof ArtistRow)
      return new ArtistItem({ name: selectedItem.artist.name });
    if (selectedItem instanceof PlaylistRow) {
      return new PlaylistItem({ playlist: selectedItem.playlist, onDelete: () => {} });
    }
    if (selectedItem !== undefined) return undefined;
    const current = currentSong(app);
    if (current === undefined) return undefined;
    return new SongItem({ ...current, extra: list.songActions?.(null) ?? [] });
  };

  const itemCommands = useItemCommands(app, {
    item: target,
    title: list.title,
    after: list.actions,
  });

  const opensCard =
    selectedItem instanceof AlbumRow ||
    selectedItem instanceof ArtistRow ||
    selectedItem instanceof PlaylistRow;

  useScreenCommands(app, [
    ...(list.keys ?? []).map(([command, run]) => [command, () => run(selectedIndex)] as const),
    [
      opensCard ? commands.open : commands.play,
      () => {
        if (selectedItem !== undefined) activate(selectedIndex);
      },
    ],
    [commands.actions, itemCommands.openActions],
    ...(router.canGoBack ? [[commands.back, router.back] as const] : []),
    [commands.up, () => select(selectedIndex - 1)],
    [commands.down, () => select(selectedIndex + 1)],
    [commands.pageUp, () => select(selectedIndex - pageStep)],
    [commands.pageDown, () => select(selectedIndex + pageStep)],
    [commands.first, () => select(0)],
    [commands.last, () => select(items.length - 1)],
    ...itemCommands.keys,
  ]);

  return {
    selected: selectedIndex,
    selectedKey: selectedItem?.key ?? null,
    select,
    activate,
    selectRow: (row: SelectableRow) => router.select(row.key),
    activateRow: (row: SelectableRow) => {
      router.select(row.key);
      activate(items.findIndex((item) => item.key === row.key));
    },
  };
}
