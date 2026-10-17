import { songLine, titleOf } from "@dyad/client-runtime";
import type { SavedSession, ServerAtoms } from "@dyad/client-runtime";
import type { AlbumCard, AlbumRef, ArtistRef, PlayContext, SourceSummary } from "@dyad/domain";
import type { NowPlaying } from "@dyad/plugin/client";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { CliRenderEvents } from "@opentui/core";
import type { Audio, BoxRenderable, InputRenderable, Renderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Data, Effect } from "effect";
import type { Fiber, Option, SubscriptionRef } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { useDialog } from "./dialog.tsx";
import { Action, ActionsDialog, HelpDialog, PluginsDialog } from "./dialogs.tsx";
import { Footer } from "./footer.tsx";
import { Header, SearchField } from "./header.tsx";
import { commands, useCommands } from "./keymap.ts";
import type { Command } from "./keymap.ts";
import { NowPlayingPanel, NowPlayingView } from "./now-playing.tsx";
import {
  AlbumRow,
  ArtistRow,
  PageView,
  RowList,
  TrackRow,
  albumRows,
  artistRows,
  pageRows,
  selectableRows,
  usePage,
} from "./page-view.tsx";
import type { SelectableRow } from "./page-view.tsx";
import type { PluginHost } from "./plugins.ts";
import {
  AlbumRoute,
  ArtistRoute,
  SectionRoute,
  sectionLabel,
  sections,
  useRoutes,
} from "./routes.ts";
import type { SectionId } from "./routes.ts";
import { Sidebar } from "./sidebar.tsx";
import { useCoverAccent } from "./theme-provider.tsx";
import { useTheme } from "./theme.ts";
import { useToast } from "./toast.tsx";
import { ListItem, ListTitle, TrackList } from "./track-list.tsx";
import { useArtwork } from "./use-artwork.ts";
import { usePlayer } from "./use-player.ts";
import { useSearch } from "./use-search.ts";

const sidebarMinWidth = 100;
const panelMinWidth = 120;
const pageStep = 10;
const upNextRows = 20;

class ActionTarget extends Data.Class<{
  readonly source: SourceSummary;
  readonly context: typeof PlayContext.Type;
  /** The position in the queue, so that the action can remove the entry */
  readonly queueIndex: number | null;
}> {}

const toItems = (sources: ReadonlyArray<SourceSummary>, context: typeof PlayContext.Type) =>
  sources.map((source) => new ListItem({ key: source.id, source, context }));

const successOr = <A,>(result: AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>) =>
  AsyncResult.isSuccess(result) ? result.value : [];

export function App(props: {
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  readonly audio: Audio;
  readonly restore: () => Option.Option<SavedSession>;
  readonly save: (session: SavedSession) => Effect.Effect<void>;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly nowPlaying: SubscriptionRef.SubscriptionRef<NowPlaying | null>;
  readonly plugins: PluginHost;
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
  const artistsResult = useAtomValue(props.atoms.libraryArtists);
  const albumsResult = useAtomValue(props.atoms.libraryAlbums);
  const refreshSources = useAtomRefresh(props.atoms.sources);
  const refreshRecent = useAtomRefresh(props.atoms.recentPlays);
  const refreshArtists = useAtomRefresh(props.atoms.libraryArtists);
  const refreshAlbums = useAtomRefresh(props.atoms.libraryAlbums);

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
    nowPlaying: props.nowPlaying,
  });
  const search = useSearch({
    connection: client,
    run: props.run,
    onFailure: (message) => toast("error", message),
  });
  const artwork = useArtwork(player.current?.source.artworkUrl ?? null);
  useCoverAccent(artwork?.accent ?? null);

  const routes = useRoutes("songs");
  const route = routes.route;
  const section = routes.section;
  const page = usePage(props.atoms, route);

  const main = useRef<BoxRenderable | null>(null);
  const searchInput = useRef<InputRenderable | null>(null);
  const [view, setView] = useState<"browse" | "nowPlaying">("browse");
  const [focusSearch, setFocusSearch] = useState(false);

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

  const reload = () => {
    refreshSources();
    refreshRecent();
    refreshArtists();
    refreshAlbums();
    page.refresh();
  };

  const previousStatus = useRef(status);
  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = status;
    if (previous === "connected" && status === "reconnecting") {
      toast("error", "The connection to the server dropped. Dyad tries again.");
    }
    // Calls fail while the connection is down, so the lists load again after it comes back
    if (previous === "reconnecting" && status === "connected") {
      reload();
      toast("notice", "Connected to the server again");
    }
  }, [status]);

  const title = player.current === undefined ? "dyad" : `${songLine(player.current.source)} · dyad`;
  useEffect(() => renderer.setTerminalTitle(title), [title]);

  // The footer renders twice a second, so the long lists keep their items between renders
  const searchItems = useMemo(() => toItems(search.results, "search"), [search.results]);
  const libraryItems = useMemo(() => toItems(successOr(sourcesResult), "library"), [sourcesResult]);
  const historyItems = useMemo(() => toItems(successOr(recentResult), "history"), [recentResult]);
  const artistItems = useMemo(() => artistRows(successOr(artistsResult)), [artistsResult]);
  const albumItems = useMemo(() => albumRows(successOr(albumsResult)), [albumsResult]);
  const pageItems = useMemo(
    () => (AsyncResult.isSuccess(page.result) ? pageRows(page.result.value) : []),
    [page.result],
  );

  const trackLists = {
    search: searchItems,
    songs: libraryItems,
    history: historyItems,
    queue: player.queue.entries.map(
      (entry) => new ListItem({ key: entry.key, source: entry.source, context: entry.context }),
    ),
  };

  const rowsOfRoute = () => {
    if (!(route instanceof SectionRoute)) return pageItems;
    if (route.section === "artists") return artistItems;
    if (route.section === "albums") return albumItems;
    return [];
  };
  const rows = rowsOfRoute();
  const trackItems =
    route instanceof SectionRoute && route.section !== "artists" && route.section !== "albums"
      ? trackLists[route.section]
      : null;
  const items = trackItems ?? selectableRows(rows);
  const onQueue = route instanceof SectionRoute && route.section === "queue";

  const indexOfSelection = () =>
    Math.max(
      0,
      items.findIndex((item) => item.key === routes.selected()),
    );
  const selectedIndex = indexOfSelection();
  const selectedItem = items[selectedIndex];

  const select = (index: number) => {
    const item = items[Math.max(0, Math.min(items.length - 1, index))];
    if (item !== undefined) routes.select(item.key);
  };

  const openArtist = (ref: ArtistRef, name: string | null) => {
    setView("browse");
    routes.push(new ArtistRoute({ ref, hint: name ?? "Unknown artist" }));
  };

  const openAlbum = (ref: AlbumRef, title: string | null) => {
    setView("browse");
    routes.push(new AlbumRoute({ ref, hint: title ?? "Unknown album" }));
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

    if (item instanceof ListItem) {
      if (onQueue) player.playEntry(index);
      else player.playList(trackItems?.map((entry) => entry.source) ?? [], index, item.context);
      return;
    }

    if (item instanceof TrackRow) playRow(item);
    if (item instanceof AlbumRow) openAlbum(item.album.ref, item.album.title);
    if (item instanceof ArtistRow) openArtist(item.artist.ref, item.artist.name);
  };

  const openSection = (id: SectionId) => {
    setView("browse");
    routes.open(id);
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

    if (view === "browse" && item instanceof ListItem) {
      return new ActionTarget({
        source: item.source,
        context: item.context,
        queueIndex: onQueue ? index : null,
      });
    }
    if (view === "browse" && item instanceof TrackRow) {
      return new ActionTarget({
        source: item.track.source,
        context: item.context,
        queueIndex: null,
      });
    }
    if (view === "browse" && item !== undefined) return item;

    const current = player.current;
    if (current === undefined) return undefined;
    return new ActionTarget({
      source: current.source,
      context: current.context,
      queueIndex: player.queue.current,
    });
  };

  // No "Go to" for the page that shows now; a source without a ref falls back to a search
  const trackActions = (target: ActionTarget) => {
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
        run: () => player.addToQueue([source], target.context),
      }),
    ];

    const artist = source.artist;
    const artistRef = source.artistRef;
    const showsArtist = route instanceof ArtistRoute && route.ref === artistRef;
    if (artistRef !== null && !showsArtist) {
      list.push(
        new Action({
          command: commands.goToArtist,
          label: `Go to artist: ${artist ?? "Unknown artist"}`,
          run: () => openArtist(artistRef, artist),
        }),
      );
    }
    if (artistRef === null && artist !== null) {
      list.push(
        new Action({
          command: commands.searchArtist,
          label: `Search the artist: ${artist}`,
          run: () => searchFor(artist),
        }),
      );
    }

    const album = source.album;
    const albumRef = source.albumRef;
    const showsAlbum = route instanceof AlbumRoute && route.ref === albumRef;
    if (albumRef !== null && !showsAlbum) {
      list.push(
        new Action({
          command: commands.goToAlbum,
          label: `Go to album: ${album ?? "Unknown album"}`,
          run: () => openAlbum(albumRef, album),
        }),
      );
    }
    if (albumRef === null && album !== null) {
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

  const albumActions = (album: AlbumCard) => {
    const artistRef = album.artistRef;
    const showsArtist = route instanceof ArtistRoute && route.ref === artistRef;
    if (artistRef === null || showsArtist) return [];

    return [
      new Action({
        command: commands.goToArtist,
        label: `Go to artist: ${album.artist ?? "Unknown artist"}`,
        run: () => openArtist(artistRef, album.artist),
      }),
    ];
  };

  const pageSources = rows.flatMap((row) =>
    row instanceof TrackRow && row.track.playable ? [row.track.source] : [],
  );
  const pageContext = route instanceof AlbumRoute ? "album" : "artist";

  const pageActions = () => {
    if (view !== "browse" || route instanceof SectionRoute || pageSources.length === 0) return [];

    return [
      new Action({
        command: commands.playAll,
        label: "Play all",
        run: () => player.playList(pageSources, 0, pageContext),
      }),
      new Action({
        command: commands.shuffleAll,
        label: "Shuffle",
        run: () => player.shuffleList(pageSources, pageContext),
      }),
      new Action({
        command: commands.addAllToQueue,
        label: "Add all to queue",
        run: () => player.addToQueue(pageSources, pageContext),
      }),
    ];
  };

  const actionsFor = (target: ReturnType<typeof actionTarget>) => {
    if (target instanceof ActionTarget) return trackActions(target);
    if (target instanceof AlbumRow) return albumActions(target.album);
    return [];
  };

  const actionTitle = (target: ReturnType<typeof actionTarget>) => {
    if (target instanceof ActionTarget) return songLine(target.source);
    if (target instanceof AlbumRow) return target.album.title;
    if (target instanceof ArtistRow) return target.artist.name;
    return route instanceof SectionRoute ? sectionLabel(route.section) : route.hint;
  };

  const runAction = (command: Command) => {
    actionsFor(actionTarget())
      .find((action) => action.command === command)
      ?.run();
  };

  const openActions = () => {
    const target = actionTarget();
    const actions = [...actionsFor(target), ...pageActions()];
    if (actions.length === 0) return;
    dialog.push(<ActionsDialog title={actionTitle(target)} actions={actions} />);
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
    [commands.plugins, () => dialog.push(<PluginsDialog host={props.plugins} run={props.run} />)],
    [commands.queue, () => openSection("queue")],
    [commands.search, startTyping],
    [commands.nextSection, () => moveSection(1)],
    [commands.previousSection, () => moveSection(-1)],
    [commands.nowPlaying, () => setView(view === "browse" ? "nowPlaying" : "browse")],
    [commands.reload, reload],
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

  const opensCard = selectedItem instanceof AlbumRow || selectedItem instanceof ArtistRow;
  const listCommands: ReadonlyArray<readonly [Command, () => void]> = [
    [
      opensCard ? commands.open : commands.play,
      () => {
        if (selectedItem !== undefined) activate(indexOfSelection());
      },
    ],
    [commands.actions, openActions],
    ...(routes.canGoBack ? [[commands.back, routes.back] as const] : []),
    [commands.up, () => select(indexOfSelection() - 1)],
    [commands.down, () => select(indexOfSelection() + 1)],
    [commands.pageUp, () => select(indexOfSelection() - pageStep)],
    [commands.pageDown, () => select(indexOfSelection() + pageStep)],
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
      : [...(onQueue ? queueCommands : []), ...listCommands];

  // The footer shows the hints in this order
  useCommands([...viewCommands, ...playbackCommands], { target: main, targetMode: "focus" });

  const showSidebar = screen.width >= sidebarMinWidth;
  const showPanel = screen.width >= panelMinWidth && screen.height >= 24;
  const panelWidth = Math.min(50, Math.floor(screen.width * 0.32));
  const bodyHeight = screen.height - 4;

  const emptyText = {
    search: search.query.trim() === "" ? "Type to search the library and the providers" : "",
    songs: AsyncResult.match(sourcesResult, {
      onInitial: () => "Loading the library",
      onFailure: () => "Cannot load the library. Press r to try again.",
      onSuccess: () => "No files. Set DYAD_LIBRARY_DIR on the server.",
    }),
    artists: AsyncResult.match(artistsResult, {
      onInitial: () => "Loading the artists",
      onFailure: () => "Cannot load the artists. Press r to try again.",
      onSuccess: () => "No artists. The library has no files with artist tags.",
    }),
    albums: AsyncResult.match(albumsResult, {
      onInitial: () => "Loading the albums",
      onFailure: () => "Cannot load the albums. Press r to try again.",
      onSuccess: () => "No albums. The library has no files with album tags.",
    }),
    history: AsyncResult.match(recentResult, {
      onInitial: () => "Loading the plays",
      onFailure: () => "Cannot load the plays. Press r to try again.",
      onSuccess: () => "No plays yet",
    }),
    queue: "The queue is empty. Press a on a track to add it.",
  };

  const counts = {
    search: searchItems.length,
    songs: libraryItems.length,
    artists: artistItems.length,
    albums: albumItems.length,
    history: historyItems.length,
    queue: trackLists.queue.length,
  };

  const listTitle =
    section === "search" && search.status !== null
      ? `${sectionLabel(section)}  ·  ${search.status}`
      : sectionLabel(section);

  // A queue can have the same source twice, so it marks the entry, not the source
  const playingKey = onQueue ? (player.current?.key ?? null) : (player.current?.source.id ?? null);

  const current = player.queue.current;
  const upNext =
    current === null ? [] : player.queue.entries.slice(current + 1, current + 1 + upNextRows);
  const openNowPlaying = () => setView("nowPlaying");

  const selectRow = (row: SelectableRow) => routes.select(row.key);
  const activateRow = (row: SelectableRow) => {
    routes.select(row.key);
    activate(items.findIndex((item) => item.key === row.key));
  };

  const content = () => {
    if (trackItems !== null) {
      return (
        <TrackList
          title={listTitle}
          items={trackItems}
          selected={selectedIndex}
          playingKey={playingKey}
          historyRows={onQueue ? (current ?? 0) : 0}
          empty={emptyText[section]}
          onSelect={select}
          onActivate={activate}
        />
      );
    }

    if (route instanceof SectionRoute) {
      const noun = route.section === "artists" ? "artist" : "album";
      return (
        <>
          <ListTitle
            title={listTitle}
            detail={
              rows.length === 0 ? "" : `${rows.length} ${noun}${rows.length === 1 ? "" : "s"}`
            }
          />
          <RowList
            rows={rows}
            selected={selectedItem?.key ?? null}
            playingId={player.current?.source.id ?? null}
            empty={emptyText[route.section]}
            onSelect={selectRow}
            onActivate={activateRow}
          />
        </>
      );
    }

    return (
      <PageView
        breadcrumb={routes.breadcrumb}
        hint={route.hint}
        result={page.result}
        rows={rows}
        selected={selectedItem?.key ?? null}
        playingId={player.current?.source.id ?? null}
        onSelect={selectRow}
        onActivate={activateRow}
      />
    );
  };

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
                count: counts[candidate.id],
              }))}
              active={section}
              onSelect={(id) => (id === "search" ? startTyping() : openSection(id))}
            />
          )}
          <box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
            {section === "search" && route instanceof SectionRoute && (
              <SearchField
                input={searchInput}
                query={search.query}
                onInput={search.search}
                onLeave={() => main.current?.focus()}
              />
            )}
            {content()}
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
