import type { CliRenderer, Renderable } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { useActiveKeys, useBindings } from "@opentui/keymap/react";
import { Data, Predicate } from "effect";
import { useRef } from "react";
import type { RefObject } from "react";

/** The help, the footer and the actions dialog show these */
export class Command extends Data.Class<{
  readonly id: string;
  readonly title: string;
  /** `null` for keys that only work inside one control and that the help does not list */
  readonly group: "Playback" | "Browse" | "Queue" | "Track" | "Playlist" | "Other" | null;
  /** Default keys in `@opentui/keymap` notation */
  readonly keys: ReadonlyArray<string>;
  /** The footer shows the first key of a command with a hint while the command is active */
  readonly hint: string | null;
}> {}

const command = (
  id: string,
  title: string,
  group: Command["group"],
  keys: ReadonlyArray<string>,
  hint: string | null = null,
) => new Command({ id, title, group, keys, hint });

export const commands = {
  quit: command("app.quit", "Quit", "Other", ["ctrl+c"]),
  help: command("app.help", "Help", "Other", ["?"], "help"),
  reload: command("app.reload", "Reload", "Other", ["r"]),
  plugins: command("app.plugins", "Plugins", "Other", ["shift+p"]),
  downloads: command("app.downloads", "Downloads", "Other", ["shift+d"]),
  accounts: command("app.accounts", "Provider accounts", "Other", ["shift+l"]),
  providerOrder: command("app.providerOrder", "Provider order", "Other", ["shift+o"]),
  close: command("app.close", "Close, go back", "Other", ["escape"], "close"),

  togglePause: command("playback.toggle", "Play or pause", "Playback", ["space"]),
  next: command("playback.next", "Next", "Playback", ["n"]),
  previous: command("playback.previous", "Previous", "Playback", ["b"]),
  seekBack: command("playback.seekBack", "Seek back 10 seconds", "Playback", ["shift+left", ","]),
  seekForward: command("playback.seekForward", "Seek forward 10 seconds", "Playback", [
    "shift+right",
    ".",
  ]),
  volumeUp: command("playback.volumeUp", "Volume up", "Playback", ["+", "="]),
  volumeDown: command("playback.volumeDown", "Volume down", "Playback", ["-"]),
  shuffle: command("playback.shuffle", "Shuffle", "Playback", ["s"]),
  repeat: command("playback.repeat", "Repeat: off, all, one", "Playback", ["shift+r"]),
  outputs: command("playback.outputs", "Play on another output", "Playback", ["o"]),
  groupOutput: command("outputs.group", "Play in sync with the active output", null, ["g"], "sync"),
  crossfade: command("outputs.crossfade", "Crossfade on or off", null, ["x"], "crossfade"),
  djMode: command("outputs.dj", "DJ mode: off or the next style", null, ["m"], "dj"),
  nowPlaying: command("view.nowPlaying", "Now playing", "Playback", ["p"], "playing"),
  visualizer: command("view.visualizer", "Show only the backdrop", "Playback", ["v"], "visual"),
  nextPreset: command("visualizer.next", "Next visual", "Playback", ["]"]),
  previousPreset: command("visualizer.previous", "Previous visual", "Playback", ["["]),
  watchVideo: command("view.video", "Watch the video", "Playback", ["shift+v"]),
  backdrop: command("view.backdrop", "Change the backdrop", "Playback", ["f"], "backdrop"),
  overlay: command("view.overlay", "Change the overlay", "Playback", ["h"], "overlay"),
  videoEarlier: command("video.earlier", "Show the video earlier", "Playback", ["["]),
  videoLater: command("video.later", "Show the video later", "Playback", ["]"]),

  play: command("list.play", "Play, queue the rest", "Browse", ["return"], "play"),
  open: command("list.open", "Open the artist, album or playlist", "Browse", ["return"], "open"),
  back: command("browse.back", "Back", "Browse", ["escape", "backspace"], "back"),
  actions: command("list.actions", "Actions", "Browse", ["a"], "actions"),
  search: command("browse.search", "Search", "Browse", ["/"], "search"),
  queue: command("browse.queue", "Queue", "Browse", ["q"], "queue"),
  nextSection: command("browse.nextSection", "Next section", "Browse", ["tab"]),
  previousSection: command("browse.previousSection", "Previous section", "Browse", ["shift+tab"]),
  up: command("list.up", "Move up", "Browse", ["up", "k"]),
  down: command("list.down", "Move down", "Browse", ["down", "j"]),
  pageUp: command("list.pageUp", "Page up", "Browse", ["pageup"]),
  pageDown: command("list.pageDown", "Page down", "Browse", ["pagedown"]),
  first: command("list.first", "First", "Browse", ["g", "home"]),
  last: command("list.last", "Last", "Browse", ["shift+g", "end"]),

  playNext: command("track.playNext", "Play next", "Track", ["shift+n"]),
  addToQueue: command("track.addToQueue", "Add to queue", "Track", ["shift+a"]),
  searchArtist: command("track.searchArtist", "Search the artist", "Track", []),
  searchAlbum: command("track.searchAlbum", "Search the album", "Track", []),
  searchTrack: command("track.searchTrack", "Search the track", "Track", []),
  goToArtist: command("track.goToArtist", "Go to the artist", "Track", []),
  goToAlbum: command("track.goToAlbum", "Go to the album", "Track", []),
  startRadio: command("track.startRadio", "Start radio", "Track", []),
  artistRadio: command("artist.startRadio", "Start artist radio", "Track", []),
  download: command("track.download", "Download", "Track", []),
  removeDownload: command("track.removeDownload", "Remove download", "Track", []),
  playAll: command("page.playAll", "Play all", "Browse", []),
  shuffleAll: command("page.shuffleAll", "Shuffle all", "Browse", []),
  addAllToQueue: command("page.addAllToQueue", "Add all to queue", "Browse", []),
  downloadAll: command("page.download", "Download all", "Browse", []),
  removeAllDownload: command("page.removeDownload", "Remove the download", "Browse", []),
  addToPlaylist: command("track.addToPlaylist", "Add to playlist", "Track", ["l"]),
  saveToLibrary: command("track.save", "Save to library", "Track", ["shift+s"]),
  removeFromLibrary: command("track.removeFromLibrary", "Remove from library", "Track", []),
  favorite: command("track.favorite", "Favorite or remove from favorites", "Track", ["shift+f"]),
  dislike: command("track.dislike", "Dislike", "Track", []),
  saveAlbum: command("page.saveAlbum", "Save or remove the album", "Browse", []),
  favoriteAlbum: command("page.favoriteAlbum", "Favorite the album", "Browse", []),
  followArtist: command("page.followArtist", "Follow or unfollow the artist", "Browse", []),
  dislikePage: command("page.dislike", "Dislike the album or artist", "Browse", []),
  heardInSets: command("track.heardInSets", "Show the DJ sets that play it", "Track", []),
  openOnWeb: command("track.openOnWeb", "Open on the provider's site", "Track", []),
  playFrom: command("track.playFrom", "Play another copy of the song", "Track", []),
  saveSetAsPlaylist: command(
    "set.saveAsPlaylist",
    "Save the identified tracks of the set as a playlist",
    "Playlist",
    [],
  ),
  remove: command("queue.remove", "Remove from queue", "Queue", ["d", "delete"], "remove"),
  newPlaylist: command("playlist.new", "New playlist", "Playlist", ["c"], "new"),
  renamePlaylist: command("playlist.rename", "Rename the playlist", "Playlist", ["e"], "rename"),
  deletePlaylist: command("playlist.delete", "Delete the playlist", "Playlist", []),
  unlinkPlaylist: command("playlist.unlink", "Unlink from the provider", "Playlist", []),
  removeEntry: command(
    "playlist.removeEntry",
    "Remove from the playlist",
    "Playlist",
    ["d", "delete"],
    "remove",
  ),
  moveEntryUp: command("playlist.moveUp", "Move up in the playlist", "Playlist", [
    "shift+up",
    "shift+k",
  ]),
  moveEntryDown: command("playlist.moveDown", "Move down in the playlist", "Playlist", [
    "shift+down",
    "shift+j",
  ]),
  clear: command("queue.clear", "Clear, keep current", "Queue", ["c"], "clear"),
  autoplay: command("queue.autoplay", "Continue with radio when the queue ends", "Queue", []),

  leaveInput: command("input.leave", "Leave the search field", null, ["escape", "down"], "leave"),
  submitInput: command("input.submit", "Show the results", null, ["return"], "results"),
  selectUp: command("select.up", "Move up", null, ["up", "ctrl+p"], "move"),
  selectDown: command("select.down", "Move down", null, ["down", "ctrl+n"]),
  choose: command("select.choose", "Choose", null, ["return"], "choose"),
  orderUp: command("order.up", "Move the provider up", null, ["shift+up", "shift+k"], "move up"),
  orderDown: command("order.down", "Move the provider down", null, ["shift+down", "shift+j"]),
  orderReset: command("order.reset", "Use the default order", null, ["d"], "default"),
  playSegment: command(
    "tracklist.play",
    "Play from this track of the set",
    null,
    ["return"],
    "play",
  ),
};

export const helpColumns = [
  ["Playback", "Playlist", "Other"],
  ["Browse", "Queue", "Track"],
] as const;

export const createKeymap = (renderer: CliRenderer) => {
  const keymap = createDefaultOpenTuiKeymap(renderer);

  keymap.registerBindingFields({
    command: (value, context) => context.attr("command", value),
    hint: (value, context) => context.attr("hint", value),
  });
  // OpenTUI 0.6.6 names a shifted symbol by its base key with the Kitty protocol, for example `/`
  // with `shift` for `?`, so a typed symbol must also match the binding of the symbol itself
  keymap.prependEventMatchResolver((event, context) => {
    const typed = event.sequence;
    const symbol = typed.length === 1 && /[^\p{L}\p{N}\s]/u.test(typed);
    if (!symbol || event.ctrl || event.meta) return undefined;
    return [context.resolveKey({ name: typed })];
  });

  return keymap;
};

/**
 * With a `target`, the keys work only while that renderable has the focus (`focus`) or contains it
 * (`focus-within`), so that a focused text input keeps its letters.
 */
export function useCommands(
  bindings: ReadonlyArray<readonly [Command, () => void]>,
  options: {
    readonly target?: RefObject<Renderable | null>;
    readonly targetMode?: "focus" | "focus-within";
  } = {},
) {
  const handlers = useRef(bindings);
  handlers.current = bindings;

  const run = (id: string) => {
    const handler = handlers.current.find(([entry]) => entry.id === id);
    handler?.[1]();
  };

  // A new layer on each render would make `useActiveKeys` render again without end
  const ids = bindings.map(([entry]) => entry.id).join(" ");

  useBindings(() => {
    const layer = {
      bindings: bindings.flatMap(([entry]) =>
        entry.keys.map((key) => ({
          key,
          cmd: () => run(entry.id),
          desc: entry.title,
          command: entry.id,
          hint: entry.hint,
        })),
      ),
    };
    if (options.target === undefined) return layer;
    return { ...layer, targetRef: options.target, targetMode: options.targetMode ?? "focus" };
  }, [ids]);
}

const keyNames = new Map([
  ["return", "⏎"],
  ["escape", "esc"],
  ["backspace", "⌫"],
  ["up", "↑"],
  ["down", "↓"],
  ["left", "←"],
  ["right", "→"],
  ["pageup", "pgup"],
  ["pagedown", "pgdn"],
  ["delete", "del"],
]);

/** A key as the help and the footer show it, for example `R` for `shift+r` */
export const keyLabel = (key: string) => {
  // A binding of the `+` key itself has no modifier
  const parts = key === "+" ? ["+"] : key.split("+");
  const name = parts.at(-1) ?? key;
  const label = keyNames.get(name) ?? name;

  if (parts.includes("shift") && /^[a-z]$/.test(name)) return name.toUpperCase();
  if (parts.includes("ctrl")) return `ctrl+${label}`;
  if (parts.includes("shift")) return `⇧${label}`;
  return label;
};

/** The hints of the active commands, one key for each command */
export function useHints() {
  const active = useActiveKeys({ includeMetadata: true });
  const seen = new Set<string>();

  return active.flatMap((key) => {
    const hint = key.bindingAttrs?.["hint"];
    const id = key.bindingAttrs?.["command"];
    if (!Predicate.isString(hint) || !Predicate.isString(id) || seen.has(id)) return [];

    seen.add(id);
    return [[keyLabel(key.display), hint] as const];
  });
}
