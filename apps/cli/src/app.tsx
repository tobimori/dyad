import { songLine } from "@dyad/client-runtime";
import type { SavedSession } from "@dyad/client-runtime";
import type { PlayContext, SourceSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { CliRenderEvents } from "@opentui/core";
import type { Audio, BoxRenderable, InputRenderable, Renderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Data, Effect } from "effect";
import type { Fiber, Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { useDialog } from "./dialog.tsx";
import { Action, ActionsDialog, HelpDialog } from "./dialogs.tsx";
import { Footer } from "./footer.tsx";
import { Header, SearchField } from "./header.tsx";
import { commands, useCommands } from "./keymap.ts";
import type { Command } from "./keymap.ts";
import { NowPlayingPanel, NowPlayingView } from "./now-playing.tsx";
import { Sidebar } from "./sidebar.tsx";
import type { ServerAtoms } from "./state.ts";
import { useCoverAccent } from "./theme-provider.tsx";
import { useTheme } from "./theme.ts";
import { useToast } from "./toast.tsx";
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
const panelMinWidth = 120;
const pageRows = 10;
const upNextRows = 20;

class ActionTarget extends Data.Class<{
  readonly source: SourceSummary;
  readonly context: typeof PlayContext.Type;
  /** The position in the queue, so that the action can remove the entry */
  readonly queueIndex: number | null;
}> {}

const toItems = (sources: ReadonlyArray<SourceSummary>) =>
  sources.map((source) => new ListItem({ key: source.id, source }));

export function App(props: {
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  readonly audio: Audio;
  readonly restore: () => Option.Option<SavedSession>;
  readonly save: (session: SavedSession) => Effect.Effect<void>;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const renderer = useRenderer();
  const screen = useTerminalDimensions();
  const theme = useTheme();
  const toast = useToast();
  const dialog = useDialog();

  const connection = useAtomValue(props.atoms.connection);
  const statusResult = useAtomValue(props.atoms.status);
  const sourcesResult = useAtomValue(props.atoms.sources);
  const recentResult = useAtomValue(props.atoms.recentPlays);
  const refreshSources = useAtomRefresh(props.atoms.sources);
  const refreshRecent = useAtomRefresh(props.atoms.recentPlays);

  const client = AsyncResult.isSuccess(connection) ? connection.value : null;
  const status = AsyncResult.isSuccess(statusResult) ? statusResult.value : "connecting";

  const player = usePlayer({
    audio: props.audio,
    serverUrl: props.serverUrl,
    connection: client,
    restore: props.restore,
    save: props.save,
    run: props.run,
    onPlayRecorded: refreshRecent,
  });
  const search = useSearch({
    connection: client,
    run: props.run,
    onFailure: (message) => toast("error", message),
  });
  const artwork = useArtwork(player.current?.source.artworkUrl ?? null);
  useCoverAccent(artwork?.accent ?? null);

  const main = useRef<BoxRenderable | null>(null);
  const searchInput = useRef<InputRenderable | null>(null);
  const [section, setSection] = useState<Section>("library");
  const [view, setView] = useState<"browse" | "nowPlaying">("browse");
  const [focusSearch, setFocusSearch] = useState(false);
  // The selection follows the item, not the row, because search results reorder while providers answer
  const [selection, setSelectionState] = useState<Record<Section, string | null>>({
    search: null,
    library: null,
    history: null,
    queue: null,
  });
  // Keys that repeat fast can come before the next render, so key handlers read the newest selection
  const selectionRef = useRef(selection);
  const setSelection = (next: Record<Section, string | null>) => {
    selectionRef.current = next;
    setSelectionState(next);
  };

  // The keys of the list work only while the main box has focus, so the focus must not get lost
  useEffect(() => {
    main.current?.focus();
    const refocus = (target: Renderable | null) => {
      if (target === null) main.current?.focus();
    };
    renderer.on(CliRenderEvents.FOCUSED_RENDERABLE, refocus);
    return () => {
      renderer.off(CliRenderEvents.FOCUSED_RENDERABLE, refocus);
    };
  }, []);

  // The search field exists only after the render that shows the search section
  useEffect(() => {
    if (!focusSearch) return;
    searchInput.current?.focus();
    setFocusSearch(false);
  }, [focusSearch]);

  const previousStatus = useRef(status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (previous === "connected" && status === "reconnecting") {
      toast("error", "The connection to the server dropped. Dyad tries again.");
    }
    // Calls fail while the connection is down, so the lists load again after it comes back
    if (previous === "reconnecting" && status === "connected") {
      refreshSources();
      refreshRecent();
      toast("notice", "Connected to the server again");
    }
  }, [status]);

  const title = player.current === undefined ? "dyad" : `${songLine(player.current.source)} · dyad`;
  useEffect(() => renderer.setTerminalTitle(title), [title]);

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
  const indexOfSelection = () =>
    Math.max(
      0,
      items.findIndex((item) => item.key === selectionRef.current[section]),
    );
  const selectedIndex = indexOfSelection();
  const selectedItem = items[selectedIndex];

  const select = (index: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, index))];
    if (item !== undefined) setSelection({ ...selectionRef.current, [section]: item.key });
  };

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

  const openSection = (id: Section) => {
    setView("browse");
    setSection(id);
  };

  const startTyping = () => {
    openSection("search");
    setFocusSearch(true);
  };

  // The search field does not take the focus here, so that `tab` can go on to the next section
  const moveSection = (direction: 1 | -1) => {
    const index = sections.findIndex((candidate) => candidate.id === section);
    const next = sections[(index + direction + sections.length) % sections.length];
    if (next !== undefined) openSection(next.id);
  };

  const searchFor = (query: string) => {
    openSection("search");
    search.search(query);
  };

  // In the list, the actions use the selected row; in the now playing view, the current source
  const actionTarget = () => {
    const index = indexOfSelection();
    const item = items[index];
    if (view === "browse" && item !== undefined) {
      if (section !== "queue") {
        return new ActionTarget({ source: item.source, context: section, queueIndex: null });
      }
      const context = player.queue.entries[index]?.context ?? "library";
      return new ActionTarget({ source: item.source, context, queueIndex: index });
    }

    const current = player.current;
    if (current === undefined) return undefined;
    return new ActionTarget({
      source: current.source,
      context: current.context,
      queueIndex: player.queue.current,
    });
  };

  const actionsFor = (target: ActionTarget) => {
    const source = target.source;
    const list = [
      new Action({
        command: commands.playNext,
        label: "Play next",
        run: () => player.playNext(source, target.context),
      }),
      new Action({
        command: commands.addToQueue,
        label: "Add to queue",
        run: () => player.addToQueue(source, target.context),
      }),
    ];

    const artist = source.artist;
    if (artist !== null) {
      list.push(
        new Action({
          command: commands.searchArtist,
          label: `Search the artist: ${artist}`,
          run: () => searchFor(artist),
        }),
      );
    }

    const album = source.album;
    if (album !== null) {
      list.push(
        new Action({
          command: commands.searchAlbum,
          label: `Search the album: ${album}`,
          run: () => searchFor(album),
        }),
      );
    }

    const queueIndex = target.queueIndex;
    if (section === "queue" && queueIndex !== null) {
      list.push(
        new Action({
          command: commands.remove,
          label: "Remove from queue",
          run: () => player.remove(queueIndex),
        }),
      );
    }
    return list;
  };

  const runAction = (command: Command) => {
    const target = actionTarget();
    if (target === undefined) return;
    actionsFor(target)
      .find((action) => action.command === command)
      ?.run();
  };

  const openActions = () => {
    const target = actionTarget();
    if (target === undefined) return;
    dialog.push(<ActionsDialog title={songLine(target.source)} actions={actionsFor(target)} />);
  };

  const quit = () => {
    search.cancel();
    renderer.setTerminalTitle("");
    props.run(
      player
        .quit()
        .pipe(
          Effect.timeout("2 seconds"),
          Effect.ignore,
          Effect.ensuring(Effect.sync(() => renderer.destroy())),
        ),
    );
  };

  useCommands([[commands.quit, quit]]);

  const playbackCommands: ReadonlyArray<readonly [Command, () => void]> = [
    [commands.help, () => dialog.push(<HelpDialog />)],
    [commands.queue, () => openSection("queue")],
    [commands.search, startTyping],
    [commands.nextSection, () => moveSection(1)],
    [commands.previousSection, () => moveSection(-1)],
    [commands.nowPlaying, () => setView(view === "browse" ? "nowPlaying" : "browse")],
    [
      commands.reload,
      () => {
        refreshSources();
        refreshRecent();
      },
    ],
    [commands.togglePause, player.togglePause],
    [commands.next, player.next],
    [commands.previous, player.previous],
    [commands.seekBack, () => player.seekBy(-player.seekStepMs)],
    [commands.seekForward, () => player.seekBy(player.seekStepMs)],
    [commands.volumeUp, () => player.changeVolume(1)],
    [commands.volumeDown, () => player.changeVolume(-1)],
    [commands.shuffle, player.toggleShuffle],
    [commands.repeat, player.cycleRepeat],
    [commands.playNext, () => runAction(commands.playNext)],
    [commands.addToQueue, () => runAction(commands.addToQueue)],
  ];

  const listCommands: ReadonlyArray<readonly [Command, () => void]> = [
    [
      commands.play,
      () => {
        if (selectedItem !== undefined) activate(indexOfSelection());
      },
    ],
    [commands.actions, openActions],
    [commands.up, () => select(indexOfSelection() - 1)],
    [commands.down, () => select(indexOfSelection() + 1)],
    [commands.pageUp, () => select(indexOfSelection() - pageRows)],
    [commands.pageDown, () => select(indexOfSelection() + pageRows)],
    [commands.first, () => select(0)],
    [commands.last, () => select(items.length - 1)],
  ];

  const queueCommands: ReadonlyArray<readonly [Command, () => void]> = [
    [
      commands.remove,
      () => {
        if (selectedItem !== undefined) player.remove(indexOfSelection());
      },
    ],
    [commands.clear, player.clear],
  ];

  const viewCommands: ReadonlyArray<readonly [Command, () => void]> =
    view === "nowPlaying"
      ? [
          [commands.close, () => setView("browse")],
          [commands.actions, openActions],
        ]
      : [...(section === "queue" ? queueCommands : []), ...listCommands];

  // The footer shows the hints in this order
  useCommands([...viewCommands, ...playbackCommands], { target: main, targetMode: "focus" });

  const showSidebar = screen.width >= sidebarMinWidth;
  const showPanel = screen.width >= panelMinWidth && screen.height >= 24;
  const panelWidth = Math.min(50, Math.floor(screen.width * 0.32));
  const bodyHeight = screen.height - 4;

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

  const current = player.queue.current;
  const upNext =
    current === null ? [] : player.queue.entries.slice(current + 1, current + 1 + upNextRows);
  const openNowPlaying = () => setView("nowPlaying");

  return (
    <box
      ref={main}
      focusable
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      <Header
        sections={showSidebar || view === "nowPlaying" ? [] : sections}
        active={section}
        server={showSidebar ? props.serverUrl : null}
        status={status}
      />
      {view === "nowPlaying" ? (
        <NowPlayingView
          entry={player.current}
          upNext={upNext}
          artwork={artwork}
          positionMs={player.position()}
          durationMs={player.durationMs()}
          width={screen.width}
          height={bodyHeight}
          onSeek={player.seekTo}
        />
      ) : (
        <box flexDirection="row" flexGrow={1}>
          {showSidebar && (
            <Sidebar
              sections={sections.map((candidate) => ({
                id: candidate.id,
                label: candidate.label,
                count: lists[candidate.id].length,
              }))}
              active={section}
              onSelect={(id) => (id === "search" ? startTyping() : openSection(id))}
            />
          )}
          <box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
            {section === "search" && (
              <SearchField
                input={searchInput}
                query={search.query}
                onInput={search.search}
                onLeave={() => main.current?.focus()}
              />
            )}
            <TrackList
              title={listTitle}
              items={items}
              selected={selectedIndex}
              playingKey={playingKey}
              historyRows={section === "queue" ? (current ?? 0) : 0}
              empty={emptyText[section]}
              onSelect={select}
              onActivate={activate}
            />
          </box>
          {showPanel && (
            <NowPlayingPanel
              entry={player.current}
              upNext={upNext}
              artwork={artwork}
              width={panelWidth}
              height={bodyHeight}
              onOpen={openNowPlaying}
            />
          )}
        </box>
      )}
      <Footer
        entry={player.current}
        state={player.state}
        positionMs={player.position()}
        durationMs={player.durationMs()}
        volume={player.volume}
        shuffle={player.queue.shuffle}
        repeat={player.queue.repeat}
        message={player.error}
        artwork={artwork}
        showCover={view === "browse" && !showPanel}
        onOpen={openNowPlaying}
        onSeek={player.seekTo}
        onVolume={player.setVolume}
      />
    </box>
  );
}
