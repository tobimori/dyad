import type { SourceSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { Audio } from "@opentui/core";
import { useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react";
import { Effect } from "effect";
import type { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useMemo, useState } from "react";

import { Footer } from "./footer.tsx";
import { Header, SearchField } from "./header.tsx";
import { hints, keyOf } from "./keys.ts";
import { NowPlaying } from "./now-playing.tsx";
import { Action, ActionsPopup, HelpPopup } from "./popups.tsx";
import type { SavedSession } from "./session.ts";
import { Sidebar } from "./sidebar.tsx";
import type { ServerAtoms } from "./state.ts";
import { themeFor } from "./theme.ts";
import { ListItem, TrackList } from "./track-list.tsx";
import { useArtwork } from "./use-artwork.ts";
import { usePlayer } from "./use-player.ts";
import { useSearch } from "./use-search.ts";

// The IDs of the list sections are also the `PlayContext` of a play that starts in them
const sections = [
  { id: "search", label: "Search" },
  { id: "library", label: "Library" },
  { id: "history", label: "Recently played" },
  { id: "queue", label: "Queue" },
] as const;

type Section = (typeof sections)[number]["id"];

const sidebarMinWidth = 100;
const nowPlayingMinWidth = 120;
const pageRows = 10;

const toItems = (sources: ReadonlyArray<SourceSummary>) =>
  sources.map((source) => new ListItem({ key: source.id, source }));

export function App(props: {
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  readonly audio: Audio;
  readonly saved: Option.Option<SavedSession>;
  readonly save: (session: SavedSession) => Effect.Effect<void>;
}) {
  const renderer = useRenderer();
  const screen = useTerminalDimensions();
  const server = useAtomValue(props.atoms.server);
  const connection = useAtomValue(props.atoms.connection);
  const sourcesResult = useAtomValue(props.atoms.sources);
  const recentResult = useAtomValue(props.atoms.recentPlays);
  const retryServer = useAtomRefresh(props.atoms.server);
  const retrySources = useAtomRefresh(props.atoms.sources);
  const refreshRecent = useAtomRefresh(props.atoms.recentPlays);

  const client = AsyncResult.isSuccess(connection) ? connection.value : null;
  const player = usePlayer({
    audio: props.audio,
    serverUrl: props.serverUrl,
    connection: client,
    saved: props.saved,
    save: props.save,
    onPlayRecorded: refreshRecent,
  });
  const search = useSearch(client);
  const artwork = useArtwork(player.current?.source.artworkUrl ?? null);
  const theme = themeFor(artwork?.accent ?? null);

  const [section, setSection] = useState<Section>("library");
  const [typing, setTyping] = useState(false);
  const [popup, setPopup] = useState<"actions" | "help" | null>(null);
  const [actionIndex, setActionIndex] = useState(0);
  // The selection follows the item, not the row, because search results reorder while providers answer
  const [selection, setSelection] = useState<Record<Section, string | null>>({
    search: null,
    library: null,
    history: null,
    queue: null,
  });

  // The footer renders twice a second, so the long lists keep their items between renders
  const searchItems = useMemo(() => toItems(search.results), [search.results]);
  const libraryItems = useMemo(
    () => toItems(AsyncResult.isSuccess(sourcesResult) ? sourcesResult.value : []),
    [sourcesResult],
  );
  const historyItems = useMemo(
    () => toItems(AsyncResult.isSuccess(recentResult) ? recentResult.value : []),
    [recentResult],
  );

  const lists = {
    search: searchItems,
    library: libraryItems,
    history: historyItems,
    queue: player.queue.entries.map(
      (entry) => new ListItem({ key: entry.key, source: entry.source }),
    ),
  };
  const items = lists[section];
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.key === selection[section]),
  );
  const selectedItem = items[selectedIndex];

  const select = (index: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, index))];
    if (item !== undefined) setSelection({ ...selection, [section]: item.key });
  };

  const contextAt = (index: number) =>
    section === "queue" ? (player.queue.entries[index]?.context ?? "library") : section;

  const activate = (index: number) => {
    if (section === "queue") {
      player.playEntry(index);
      return;
    }
    player.playList(
      items.map((item) => item.source),
      index,
      section,
    );
  };

  const searchFor = (query: string) => {
    setSection("search");
    setTyping(false);
    search.search(query);
  };

  // The actions use the selected row, or the source that plays when the list is empty
  const actionSource = selectedItem?.source ?? player.current?.source;
  const actionContext =
    selectedItem === undefined ? (player.current?.context ?? "library") : contextAt(selectedIndex);

  const actionsFor = (source: SourceSummary) => {
    const list = [
      new Action({ label: "Play next", run: () => player.playNext(source, actionContext) }),
      new Action({ label: "Add to queue", run: () => player.addToQueue(source, actionContext) }),
    ];

    const artist = source.artist;
    if (artist !== null) {
      list.push(
        new Action({ label: `Search the artist: ${artist}`, run: () => searchFor(artist) }),
      );
    }

    const album = source.album;
    if (album !== null) {
      list.push(new Action({ label: `Search the album: ${album}`, run: () => searchFor(album) }));
    }

    if (section === "queue" && selectedItem !== undefined) {
      list.push(
        new Action({ label: "Remove from queue", run: () => player.remove(selectedIndex) }),
      );
    }
    return list;
  };

  const actions = actionSource === undefined ? [] : actionsFor(actionSource);

  const runAction = (index: number) => {
    setPopup(null);
    actions[index]?.run();
  };

  const moveSection = (direction: 1 | -1) => {
    const index = sections.findIndex((candidate) => candidate.id === section);
    const next = sections[(index + direction + sections.length) % sections.length];
    if (next !== undefined) setSection(next.id);
  };

  const quit = () => {
    search.cancel();
    Effect.runFork(
      player
        .quit()
        .pipe(
          Effect.timeout("2 seconds"),
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => renderer.destroy())),
        ),
    );
  };

  const removeSelected = () => {
    if (section === "queue" && selectedItem !== undefined) player.remove(selectedIndex);
  };

  const listKeys = new Map<string, () => void>([
    [
      "/",
      () => {
        setSection("search");
        setTyping(true);
      },
    ],
    ["?", () => setPopup("help")],
    [
      "a",
      () => {
        if (actions.length === 0) return;
        setActionIndex(0);
        setPopup("actions");
      },
    ],
    ["q", quit],
    [
      "r",
      () => {
        retryServer();
        retrySources();
        refreshRecent();
      },
    ],
    ["space", player.togglePause],
    ["n", player.next],
    ["b", player.previous],
    ["+", () => player.changeVolume(1)],
    ["=", () => player.changeVolume(1)],
    ["-", () => player.changeVolume(-1)],
    [",", () => player.seekBy(-player.seekStepMs)],
    [".", () => player.seekBy(player.seekStepMs)],
    ["s", player.toggleShuffle],
    ["R", player.cycleRepeat],
    ["up", () => select(selectedIndex - 1)],
    ["k", () => select(selectedIndex - 1)],
    ["down", () => select(selectedIndex + 1)],
    ["j", () => select(selectedIndex + 1)],
    ["pageup", () => select(selectedIndex - pageRows)],
    ["pagedown", () => select(selectedIndex + pageRows)],
    ["g", () => select(0)],
    ["home", () => select(0)],
    ["G", () => select(items.length - 1)],
    ["end", () => select(items.length - 1)],
    [
      "return",
      () => {
        if (selectedItem !== undefined) activate(selectedIndex);
      },
    ],
    ["d", removeSelected],
    ["delete", removeSelected],
    [
      "c",
      () => {
        if (section === "queue") player.clear();
      },
    ],
  ]);

  const popupKey = (name: string) => {
    if (popup === "help") {
      if (name === "escape" || name === "?" || name === "q") setPopup(null);
      return;
    }
    if (name === "escape" || name === "a") setPopup(null);
    if (name === "up" || name === "k") setActionIndex(Math.max(0, actionIndex - 1));
    if (name === "down" || name === "j") {
      setActionIndex(Math.min(actions.length - 1, actionIndex + 1));
    }
    if (name === "return") runAction(actionIndex);
  };

  useKeyboard((key) => {
    const name = keyOf(key);
    if (key.ctrl && key.name === "c") {
      quit();
      return;
    }
    if (popup !== null) {
      popupKey(name);
      return;
    }

    // OpenTUI 0.6.6 runs global key handlers before the focused input, so typed text must not
    // reach the commands below
    if (typing) {
      if (name === "escape" || name === "down") setTyping(false);
      return;
    }

    if (name === "tab") {
      moveSection(key.shift ? -1 : 1);
      return;
    }
    if (key.shift && name === "left") {
      player.seekBy(-player.seekStepMs);
      return;
    }
    if (key.shift && name === "right") {
      player.seekBy(player.seekStepMs);
      return;
    }
    listKeys.get(name)?.();
  });

  const showSidebar = screen.width >= sidebarMinWidth;
  const showNowPlaying = screen.width >= nowPlayingMinWidth && screen.height >= 24;
  const nowPlayingWidth = Math.min(50, Math.floor(screen.width * 0.32));
  const bodyHeight = screen.height - 4;

  const serverStatus = AsyncResult.match(server, {
    onInitial: () => "Connecting",
    onFailure: () => "Unavailable",
    onSuccess: () => "Connected",
  });

  const emptyText = {
    search: search.query.trim() === "" ? "Type to search the library and the providers" : "",
    library: AsyncResult.match(sourcesResult, {
      onInitial: () => "Loading the library",
      onFailure: () => "Cannot load the library. Press r to try again.",
      onSuccess: () => "No files. Set DYAD_LIBRARY_DIR on the server.",
    }),
    history: AsyncResult.match(recentResult, {
      onInitial: () => "Loading the plays",
      onFailure: () => "Cannot load the plays. Press r to try again.",
      onSuccess: () => "No plays yet",
    }),
    queue: "The queue is empty. Press a on a track to add it.",
  };

  const sectionLabel = sections.find((candidate) => candidate.id === section)?.label ?? "";
  const listTitle =
    section === "search" && search.status !== null
      ? `${sectionLabel}  ·  ${search.status}`
      : sectionLabel;

  // A queue can have the same source twice, so it marks the entry, not the source
  const playingKey =
    section === "queue" ? (player.current?.key ?? null) : (player.current?.source.id ?? null);

  const hintKeys = () => {
    if (popup !== null) return hints[popup];
    if (typing) return hints.input;
    if (section === "queue") return hints.queue;
    return hints.list;
  };

  const current = player.queue.current;
  const upNext = current === null ? [] : player.queue.entries.slice(current + 1, current + 6);

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background}>
      <Header
        sections={showSidebar ? [] : sections}
        active={section}
        status={showSidebar ? `${props.serverUrl} · ${serverStatus}` : serverStatus}
        theme={theme}
      />
      <box flexDirection="row" flexGrow={1}>
        {showSidebar && (
          <Sidebar
            sections={sections.map((candidate) => ({
              id: candidate.id,
              label: candidate.label,
              count: lists[candidate.id].length,
            }))}
            active={section}
            theme={theme}
            onSelect={(id) => {
              setSection(id);
              setTyping(id === "search");
            }}
          />
        )}
        <box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
          {section === "search" && (
            <SearchField
              query={search.query}
              focused={typing}
              theme={theme}
              onFocus={() => setTyping(true)}
              onInput={search.search}
              onSubmit={() => setTyping(false)}
            />
          )}
          <TrackList
            title={listTitle}
            items={items}
            selected={selectedIndex}
            playingKey={playingKey}
            historyRows={section === "queue" ? (current ?? 0) : 0}
            empty={emptyText[section]}
            theme={theme}
            onSelect={select}
            onActivate={activate}
          />
        </box>
        {showNowPlaying && (
          <NowPlaying
            entry={player.current}
            upNext={upNext}
            artwork={artwork}
            width={nowPlayingWidth}
            height={bodyHeight}
            theme={theme}
          />
        )}
      </box>
      <Footer
        entry={player.current}
        state={player.state}
        positionMs={player.position()}
        durationMs={player.durationMs()}
        volume={player.volume}
        shuffle={player.queue.shuffle}
        repeat={player.queue.repeat}
        message={player.error}
        hints={hintKeys()}
        width={screen.width - 2}
        theme={theme}
      />
      {popup === "actions" && (
        <ActionsPopup
          title={actionSource?.title ?? "Actions"}
          actions={actions}
          selected={actionIndex}
          screen={screen}
          theme={theme}
          onRun={runAction}
        />
      )}
      {popup === "help" && <HelpPopup screen={screen} theme={theme} />}
    </box>
  );
}
