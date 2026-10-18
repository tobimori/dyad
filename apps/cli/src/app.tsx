import { DownloadPin, songLine, titleOf } from "@dyad/client-runtime";
import type { Downloads, ServerAtoms, SessionClient } from "@dyad/client-runtime";
import { segmentIndexAt, segmentSkipTarget } from "@dyad/domain";
import type {
  AlbumCard,
  AlbumRef,
  ArtistRef,
  DownloadQuality,
  PlayContext,
  SourceSegment,
  SourceSummary,
} from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { CliRenderEvents } from "@opentui/core";
import type { BoxRenderable, Renderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Data, Effect, SubscriptionRef } from "effect";
import type { Fiber } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";

import { AccountsDialog } from "./component/dialog-accounts.tsx";
import { Action, ActionsDialog } from "./component/dialog-actions.tsx";
import { DownloadsDialog, QualityDialog } from "./component/dialog-downloads.tsx";
import { HelpDialog } from "./component/dialog-help.tsx";
import { OutputsDialog } from "./component/dialog-outputs.tsx";
import { PluginsDialog } from "./component/dialog-plugins.tsx";
import { Footer } from "./component/footer.tsx";
import { Header } from "./component/header.tsx";
import {
  AlbumRow,
  ArtistRow,
  PlaylistRow,
  TrackRow,
  selectableRows,
} from "./component/row-list.tsx";
import type { SelectableRow } from "./component/row-list.tsx";
import { Sidebar } from "./component/sidebar.tsx";
import { ListItem, UnavailableItem, playsSource } from "./component/track-list.tsx";
import type { TrackItem } from "./component/track-list.tsx";
import { useArtwork } from "./component/use-artwork.ts";
import { commands, useCommands } from "./context/keymap.ts";
import type { Command } from "./context/keymap.ts";
import type { PluginHost } from "./context/plugin-host.ts";
import {
  AlbumRoute,
  ArtistRoute,
  PlaylistRoute,
  SectionRoute,
  useRoutes,
} from "./context/routes.ts";
import type { Section } from "./context/routes.ts";
import { useCoverAccent } from "./context/theme-provider.tsx";
import { useSearch } from "./context/use-search.ts";
import type { Engine } from "./playback/engine.ts";
import { restartAfterMs, usePlayer } from "./playback/use-player.ts";
import { useSegments } from "./playback/use-segments.ts";
import { NowPlayingPanel, NowPlayingView, segmentLine } from "./routes/now-playing.tsx";
import { PageView, pageRows, usePage } from "./routes/page/page-view.tsx";
import { PlaylistView, usePlaylist } from "./routes/page/playlist-view.tsx";
import { sections, startSection } from "./routes/sections.ts";
import { useTheme } from "./theme/theme.ts";
import { useDialog } from "./ui/dialog.tsx";
import { useToast } from "./ui/toast.tsx";
import { VisualizerView } from "./visualizer/visualizer-view.tsx";

const sidebarMinWidth = 100;
const panelMinWidth = 120;
const pageStep = 10;
const upNextRows = 20;

class ActionTarget extends Data.Class<{
  readonly source: SourceSummary;
  readonly context: typeof PlayContext.Type;
  readonly sectionActions: ReadonlyArray<Action>;
}> {}

export function App(props: {
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  readonly session: typeof SessionClient.Service;
  /** `null` when this device only controls */
  readonly engine: typeof Engine.Service | null;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly plugins: PluginHost;
  /** `null` when this device only controls */
  readonly downloads: typeof Downloads.Service | null;
  readonly downloadQuality: typeof DownloadQuality.Type;
  readonly saveDownloadQuality: (quality: typeof DownloadQuality.Type) => void;
}) {
  const renderer = useRenderer();
  const screen = useTerminalDimensions();
  const theme = useTheme();
  const toast = useToast();
  const dialog = useDialog();

  const connection = useAtomValue(props.atoms.connection);
  const statusResult = useAtomValue(props.atoms.status);
  const refreshRecent = useAtomRefresh(props.atoms.recentPlays);

  const client = AsyncResult.isSuccess(connection) ? connection.value : null;
  const status = AsyncResult.isSuccess(statusResult) ? statusResult.value : "connecting";

  const player = usePlayer({
    session: props.session,
    engine: props.engine,
    run: props.run,
    notify: (message) => toast("error", message),
    inform: (message) => toast("notice", message),
  });
  // The server records a play when its entry stops being current
  useEffect(refreshRecent, [player.current?.id]);
  const search = useSearch({
    connection: client,
    run: props.run,
    onFailure: (message) => toast("error", message),
  });
  const artwork = useArtwork(player.current?.source.artworkUrl ?? null);
  const segments = useSegments(props.atoms, player.current?.source.id);
  const currentSegment = segmentIndexAt(segments, player.position());
  // `null` follows the track that plays
  const [segmentSelection, setSegmentSelection] = useState<number | null>(null);
  useEffect(() => setSegmentSelection(null), [player.current?.id]);
  const selectedSegment = segmentSelection ?? Math.max(0, currentSegment);
  useCoverAccent(artwork?.accent ?? null);

  const routes = useRoutes(startSection);
  const route = routes.route;
  const section = routes.section;
  const page = usePage(props.atoms, route);
  const playlist = usePlaylist(props.atoms, route);

  const main = useRef<BoxRenderable | null>(null);
  const [downloadQuality, setDownloadQuality] = useState(props.downloadQuality);
  const [view, setView] = useState<"browse" | "nowPlaying" | "visualizer">("browse");

  // `sections` never changes, so each render calls the same hooks in the same order
  const views = new Map(
    sections.map(
      (entry) =>
        [
          entry,
          entry.useView({
            atoms: props.atoms,
            player,
            search,
            focusList: () => main.current?.focus(),
          }),
        ] as const,
    ),
  );
  // A route holds only sections from `sections`
  const sectionView = views.get(section)!;

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

  const reload = () => {
    for (const entry of views.values()) entry.refresh?.();
    page.refresh();
    playlist.refresh();
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

  // The footer renders twice a second, so the page keeps its rows between renders
  const pageItems = useMemo(
    () => (AsyncResult.isSuccess(page.result) ? pageRows(page.result.value) : []),
    [page.result],
  );
  const routeItems = () => {
    if (route instanceof SectionRoute) return sectionView.items;
    if (route instanceof PlaylistRoute) return playlist.items;
    return selectableRows(pageItems);
  };
  const items: ReadonlyArray<TrackItem | SelectableRow> = routeItems();

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

  const openPlaylist = (id: string, name: string) => {
    setView("browse");
    routes.push(new PlaylistRoute({ id, hint: name }));
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

    if (
      item instanceof ListItem &&
      route instanceof SectionRoute &&
      sectionView.play !== undefined
    ) {
      sectionView.play(index);
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
    if (item instanceof AlbumRow) openAlbum(item.album.ref, item.album.title);
    if (item instanceof ArtistRow) openArtist(item.artist.ref, item.artist.name);
    if (item instanceof PlaylistRow) openPlaylist(item.playlist.id, item.playlist.name);
  };

  const openSection = (target: Section) => {
    setView("browse");
    routes.open(target);
  };

  const enterSection = (target: Section) => {
    openSection(target);
    views.get(target)?.focus?.();
  };

  // `q` and `/` open the section that registered the command
  const sectionOf = (command: Command) => sections.find((entry) => entry.command === command);

  const enterSectionOf = (command: Command) => {
    const target = sectionOf(command);
    if (target !== undefined) enterSection(target);
  };

  // `tab` does not focus the section, so that it can go on to the next one
  const moveSection = (direction: 1 | -1) => {
    const index = sections.indexOf(section);
    const next = sections[(index + direction + sections.length) % sections.length];
    if (next !== undefined) openSection(next);
  };

  const searchFor = (query: string) => {
    const target = sectionOf(commands.search);
    if (target !== undefined) openSection(target);
    search.search(query);
  };

  const actionTarget = () => {
    const index = indexOfSelection();
    const item = items[index];

    if (view === "browse" && item instanceof ListItem) {
      return new ActionTarget({
        source: item.source,
        context: item.context,
        sectionActions: route instanceof SectionRoute ? (sectionView.actions?.(index) ?? []) : [],
      });
    }
    if (view === "browse" && item instanceof TrackRow) {
      return new ActionTarget({
        source: item.track.source,
        context: item.context,
        sectionActions: [],
      });
    }
    if (view === "browse" && item !== undefined) return item;

    const current = player.current;
    if (current === undefined) return undefined;
    return new ActionTarget({
      source: current.source,
      context: current.context,
      sectionActions: sectionView.actions?.(null) ?? [],
    });
  };

  const downloadActions = (
    target: Pick<DownloadPin, "kind" | "id" | "title" | "sourceIds">,
    add: Command,
    remove: Command,
  ) => {
    const downloads = props.downloads;
    if (downloads === null) return [];

    const noun = target.kind === "song" ? "" : ` ${target.kind}`;
    const pinned = SubscriptionRef.getUnsafe(downloads.state).pins.some(
      (pin) => pin.kind === target.kind && pin.id === target.id,
    );
    if (pinned) {
      return [
        new Action({
          command: remove,
          label: `Remove${noun} download`,
          run: () => {
            props.run(downloads.unpin(target.kind, target.id));
            toast("notice", `Removed the download of ${target.title}`);
          },
        }),
      ];
    }

    const download = (quality: typeof DownloadQuality.Type) => {
      props.run(downloads.pin(new DownloadPin({ ...target, quality })));
      toast("notice", `Downloading ${target.title}`);
    };
    return [
      new Action({
        command: add,
        label: `Download${noun}`,
        run: () =>
          dialog.push(
            <QualityDialog
              title={`Download ${target.title}`}
              current={downloadQuality}
              onChoose={download}
            />,
          ),
      }),
    ];
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

    const song = {
      kind: "song" as const,
      id: source.id,
      title: titleOf(source),
      sourceIds: [source.id],
    };
    return [
      ...list,
      ...downloadActions(song, commands.download, commands.removeDownload),
      ...target.sectionActions,
    ];
  };

  const albumActions = (album: AlbumCard) => {
    const artistRef = album.artistRef;
    const showsArtist = route instanceof ArtistRoute && route.ref === artistRef;
    // The downloads read the songs of the album when they run online
    const download = downloadActions(
      { kind: "album", id: album.ref, title: album.title, sourceIds: [] },
      commands.downloadAll,
      commands.removeAllDownload,
    );
    if (artistRef === null || showsArtist) return download;

    return [
      new Action({
        command: commands.goToArtist,
        label: `Go to artist: ${album.artist ?? "Unknown artist"}`,
        run: () => openArtist(artistRef, album.artist),
      }),
      ...download,
    ];
  };

  const pageSources =
    route instanceof PlaylistRoute
      ? playlist.items.flatMap((item) => (item instanceof ListItem ? [item.source] : []))
      : pageItems.flatMap((row) =>
          row instanceof TrackRow && row.track.playable ? [row.track.source] : [],
        );
  const pageContext = () => {
    if (route instanceof AlbumRoute) return "album";
    if (route instanceof ArtistRoute) return "artist";
    if (route instanceof PlaylistRoute) return "playlist";
    return "library";
  };

  const pageDownloadActions = () => {
    const sourceIds = pageSources.map((source) => source.id);
    if (route instanceof AlbumRoute) {
      const album = { kind: "album" as const, id: route.ref, title: route.hint, sourceIds };
      return downloadActions(album, commands.downloadAll, commands.removeAllDownload);
    }
    if (route instanceof PlaylistRoute) {
      const playlist = { kind: "playlist" as const, id: route.id, title: route.hint, sourceIds };
      return downloadActions(playlist, commands.downloadAll, commands.removeAllDownload);
    }
    return [];
  };

  const pageActions = () => {
    if (view !== "browse" || route instanceof SectionRoute || pageSources.length === 0) return [];

    return [
      new Action({
        command: commands.playAll,
        label: "Play all",
        run: () => player.playList(pageSources, 0, pageContext()),
      }),
      new Action({
        command: commands.shuffleAll,
        label: "Shuffle",
        run: () => player.shuffleList(pageSources, pageContext()),
      }),
      new Action({
        command: commands.addAllToQueue,
        label: "Add all to queue",
        run: () => player.addToQueue(pageSources, pageContext()),
      }),
      ...pageDownloadActions(),
    ];
  };

  const playSegment = (index: number) => {
    const segment = segments[index];
    if (segment === undefined) return;
    setSegmentSelection(index);
    if (segment.startMs === null) toast("notice", "The tracklist gives no time for this track");
    else player.seekTo(segment.startMs);
  };

  // Like `n` and `b` on an album, but inside the source. At the ends they go to the next entry.
  const skip = (direction: 1 | -1) => {
    const target = segmentSkipTarget(segments, player.position(), direction, restartAfterMs);
    if (target !== undefined) player.seekTo(target);
    else if (direction === 1) player.next();
    else player.previous();
  };

  const segmentActions = (segment: SourceSegment) => {
    const list = [
      new Action({
        command: commands.playSegment,
        label: "Play from this track",
        run: () => playSegment(segments.indexOf(segment)),
      }),
    ];
    const { artist, artistRef, album, albumRef } = segment;
    if (artistRef !== null) {
      list.push(
        new Action({
          command: commands.goToArtist,
          label: `Go to artist: ${artist ?? "Unknown artist"}`,
          run: () => openArtist(artistRef, artist),
        }),
      );
    }
    if (albumRef !== null) {
      list.push(
        new Action({
          command: commands.goToAlbum,
          label: `Go to album: ${album ?? "Unknown album"}`,
          run: () => openAlbum(albumRef, album),
        }),
      );
    }
    // Unknown tracks are `ID - ID`
    if (artistRef === null && segment.title.toUpperCase() !== "ID") {
      const query = segmentLine(segment).replace(" – ", " ");
      list.push(
        new Action({
          command: commands.searchTrack,
          label: `Search the track: ${query}`,
          run: () => searchFor(query),
        }),
      );
    }
    return list;
  };

  const shownSegment = view === "nowPlaying" ? segments[selectedSegment] : undefined;

  // In a DJ set, the actions of the selected track come before the actions of the set
  const actionsFor = (target: ReturnType<typeof actionTarget>) => {
    const inSet = shownSegment === undefined ? [] : segmentActions(shownSegment);
    if (target instanceof ActionTarget) return [...inSet, ...trackActions(target)];
    if (target instanceof AlbumRow) return albumActions(target.album);
    return [];
  };

  const actionTitle = (target: ReturnType<typeof actionTarget>) => {
    if (target instanceof ActionTarget) return songLine(target.source);
    if (target instanceof AlbumRow) return target.album.title;
    if (target instanceof ArtistRow) return target.artist.name;
    return route instanceof SectionRoute ? route.section.title : route.hint;
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
    [
      commands.accounts,
      () => {
        if (client === null) return;
        dialog.push(<AccountsDialog connection={client} run={props.run} />);
      },
    ],
    [
      commands.downloads,
      () => {
        if (props.downloads === null) return;
        dialog.push(
          <DownloadsDialog
            downloads={props.downloads}
            quality={downloadQuality}
            setQuality={(quality) => {
              setDownloadQuality(quality);
              props.saveDownloadQuality(quality);
            }}
            run={props.run}
          />,
        );
      },
    ],
    [
      commands.outputs,
      () =>
        dialog.push(
          <OutputsDialog
            session={props.session}
            run={props.run}
            transfer={player.transfer}
            setVolume={player.setOutputVolume}
          />,
        ),
    ],
    [commands.queue, () => enterSectionOf(commands.queue)],
    [commands.search, () => enterSectionOf(commands.search)],
    [commands.nextSection, () => moveSection(1)],
    [commands.previousSection, () => moveSection(-1)],
    [commands.nowPlaying, () => setView(view === "browse" ? "nowPlaying" : "browse")],
    [commands.visualizer, () => setView(view === "visualizer" ? "browse" : "visualizer")],
    [commands.reload, reload],
    [commands.togglePause, player.togglePause],
    [commands.next, () => skip(1)],
    [commands.previous, () => skip(-1)],
    [commands.seekBack, () => player.seekBy(-player.seekStepMs)],
    [commands.seekForward, () => player.seekBy(player.seekStepMs)],
    [commands.volumeUp, () => player.changeVolume(1)],
    [commands.volumeDown, () => player.changeVolume(-1)],
    [commands.shuffle, player.toggleShuffle],
    [commands.repeat, player.cycleRepeat],
    [commands.playNext, () => runAction(commands.playNext)],
    [commands.addToQueue, () => runAction(commands.addToQueue)],
  ];

  const opensCard =
    selectedItem instanceof AlbumRow ||
    selectedItem instanceof ArtistRow ||
    selectedItem instanceof PlaylistRow;
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

  const sectionKeys = route instanceof SectionRoute ? (sectionView.keys ?? []) : [];
  const sectionCommands = sectionKeys.map(
    ([command, run]) => [command, () => run(indexOfSelection())] as const,
  );

  const selectSegment = (index: number) =>
    setSegmentSelection(Math.max(0, Math.min(segments.length - 1, index)));
  const segmentCommands: ReadonlyArray<readonly [Command, () => void]> =
    view === "nowPlaying" && segments.length > 0
      ? [
          [commands.playSegment, () => playSegment(selectedSegment)],
          [commands.up, () => selectSegment(selectedSegment - 1)],
          [commands.down, () => selectSegment(selectedSegment + 1)],
          [commands.pageUp, () => selectSegment(selectedSegment - pageStep)],
          [commands.pageDown, () => selectSegment(selectedSegment + pageStep)],
          [commands.first, () => selectSegment(0)],
          [commands.last, () => selectSegment(segments.length - 1)],
        ]
      : [];

  const viewCommands: ReadonlyArray<readonly [Command, () => void]> =
    view === "browse"
      ? [...sectionCommands, ...listCommands]
      : [
          ...segmentCommands,
          [commands.close, () => setView("browse")],
          [commands.actions, openActions],
        ];

  // The footer shows the hints in this order
  useCommands([...viewCommands, ...playbackCommands], { target: main, targetMode: "focus" });

  const showSidebar = screen.width >= sidebarMinWidth;
  const showPanel = screen.width >= panelMinWidth && screen.height >= 24;
  const panelWidth = Math.min(50, Math.floor(screen.width * 0.32));
  const bodyHeight = screen.height - 4;

  const current = player.currentIndex;
  const upNext =
    current === null ? [] : player.entries.slice(current + 1, current + 1 + upNextRows);
  const openNowPlaying = () => setView("nowPlaying");

  const selectRow = (row: SelectableRow) => routes.select(row.key);
  const activateRow = (row: SelectableRow) => {
    routes.select(row.key);
    activate(items.findIndex((item) => item.key === row.key));
  };

  const content = () => {
    if (route instanceof SectionRoute) {
      return sectionView.render({
        selected: selectedIndex,
        select,
        activate,
        selectRow,
        activateRow,
      });
    }

    if (route instanceof PlaylistRoute) {
      return (
        <PlaylistView
          atoms={props.atoms}
          route={route}
          breadcrumb={routes.breadcrumb}
          result={playlist.result}
          items={playlist.items}
          selected={selectedIndex}
          playing={playsSource(player.current?.source.id)}
          onSelect={select}
          onActivate={activate}
        />
      );
    }

    return (
      <PageView
        breadcrumb={routes.breadcrumb}
        hint={route.hint}
        result={page.result}
        rows={pageItems}
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
      {view !== "visualizer" && (
        <Header
          sections={showSidebar || view === "nowPlaying" ? [] : sections}
          active={section.id}
          server={showSidebar ? props.serverUrl : null}
          status={status}
        />
      )}
      {view === "visualizer" && (
        <VisualizerView
          source={player.current?.source}
          artwork={artwork}
          playing={player.state === "playing"}
          tap={player.tap}
          positionMs={player.position}
          durationMs={player.durationMs()}
          width={screen.width}
          height={screen.height}
        />
      )}
      {view === "nowPlaying" && (
        <NowPlayingView
          entry={player.current}
          segments={segments}
          currentSegment={currentSegment}
          selectedSegment={selectedSegment}
          onSelectSegment={setSegmentSelection}
          onPlaySegment={playSegment}
          upNext={upNext}
          artwork={artwork}
          positionMs={player.position()}
          durationMs={player.durationMs()}
          width={screen.width}
          height={bodyHeight}
          onSeek={player.seekTo}
        />
      )}
      {view === "browse" && (
        <box flexDirection="row" flexGrow={1}>
          {showSidebar && (
            <Sidebar
              sections={sections}
              count={(entry) => views.get(entry)?.items.length ?? 0}
              active={section}
              onSelect={enterSection}
            />
          )}
          <box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
            {content()}
          </box>
          {showPanel && (
            <NowPlayingPanel
              entry={player.current}
              segment={segments[currentSegment]}
              upNext={upNext}
              artwork={artwork}
              width={panelWidth}
              height={bodyHeight}
              onOpen={openNowPlaying}
            />
          )}
        </box>
      )}
      {view !== "visualizer" && (
        <Footer
          entry={player.current}
          state={player.state}
          positionMs={player.position()}
          durationMs={player.durationMs()}
          volume={player.volume}
          muted={player.muted}
          quality={player.quality()}
          shuffle={player.shuffle}
          repeat={player.repeat}
          message={
            player.error ?? player.offline ?? (player.lost ? "The output does not answer" : null)
          }
          artwork={artwork}
          showCover={view === "browse" && !showPanel}
          segments={segments}
          currentSegment={currentSegment}
          onOpen={openNowPlaying}
          onSeek={player.seekTo}
          onVolume={player.setVolume}
        />
      )}
    </box>
  );
}
