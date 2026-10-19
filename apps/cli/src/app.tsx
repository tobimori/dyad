import { songLine } from "@dyad/client-runtime";
import type {
  Downloads,
  ListenFeed,
  ServerConnection,
  ServerAtoms,
  SessionClient,
} from "@dyad/client-runtime";
import { segmentIndexAt } from "@dyad/domain";
import type { AlbumRef, ArtistRef, DownloadQuality } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { CliRenderEvents } from "@opentui/core";
import type { BoxRenderable, Renderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Effect } from "effect";
import type { Fiber } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { AccountsDialog } from "./component/dialog-accounts.tsx";
import { DownloadsDialog, useDownloadAction } from "./component/dialog-downloads.tsx";
import { HelpDialog } from "./component/dialog-help.tsx";
import { OutputsDialog } from "./component/dialog-outputs.tsx";
import { RoomsDialog } from "./component/dialog-rooms.tsx";
import { usePlaylistActions } from "./component/dialog-playlists.tsx";
import { useLibraryMarks } from "./component/library-marks.ts";
import { PluginsDialog } from "./component/dialog-plugins.tsx";
import { ProviderOrderDialog } from "./component/dialog-provider-order.tsx";
import { Footer } from "./component/footer.tsx";
import { Header } from "./component/header.tsx";
import { Sidebar } from "./component/sidebar.tsx";
import { useArtwork } from "./component/use-artwork.ts";
import { commands, useCommands } from "./context/keymap.ts";
import type { Command } from "./context/keymap.ts";
import type { PluginHost } from "./context/plugin-host.ts";
import { ActionApp } from "./context/action-items.ts";
import type { SongItem } from "./context/action-items.ts";
import { useItemActions } from "./context/item-actions.ts";
import { Route, sectionPlace, useRouter } from "./context/router.ts";
import type { Place } from "./context/router.ts";
import type { Section } from "./context/routes.ts";
import { ScreenApp } from "./context/screen-app.ts";
import { useCoverAccent } from "./context/theme-provider.tsx";
import { useSearch } from "./context/use-search.ts";
import type { Engine } from "./playback/engine.ts";
import { usePlayer } from "./playback/use-player.ts";
import { useSegments } from "./playback/use-segments.ts";
import { NowPlayingPanel, NowPlayingScreen, upNextOf } from "./routes/now-playing.tsx";
import { PageScreen } from "./routes/page/page-view.tsx";
import { PlaylistScreen } from "./routes/page/playlist-view.tsx";
import { sections, startSection } from "./routes/sections.ts";
import { useTheme } from "./theme/theme.ts";
import { useDialog } from "./ui/dialog.tsx";
import { useToast } from "./ui/toast.tsx";
import { useCoverVideo } from "./video/video-view.tsx";
import { useBackdrop } from "./visualizer/backdrop.tsx";

const sidebarMinWidth = 100;
const panelMinWidth = 120;

export function App(props: {
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  readonly session: typeof SessionClient.Service;
  /** `null` when this device only controls */
  readonly engine: typeof Engine.Service | null;
  readonly listen: ListenFeed;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly plugins: PluginHost;
  /** `null` when this device only controls */
  readonly downloads: typeof Downloads.Service | null;
  readonly downloadQuality: typeof DownloadQuality.Type;
  readonly saveDownloadQuality: (quality: typeof DownloadQuality.Type) => void;
  /** The replica of this device, for edits */
  readonly replica: typeof ServerConnection.Service;
  /** The screen at the last quit */
  readonly place: Place | undefined;
  readonly savePlace: (place: Place) => void;
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
    listen: props.listen,
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
  useCoverAccent(artwork?.accent ?? null);

  // A saved section that the app no longer has opens the start section
  const saved = props.place;
  const known = saved !== undefined && sections.some((entry) => entry.id === saved.section);
  const routes = useRouter(known ? saved : sectionPlace(startSection.id), props.savePlace);
  const route = routes.route;
  const section = sections.find((entry) => entry.id === routes.place.section) ?? startSection;
  const nowPlaying = Route.guards.NowPlaying(route);
  const titleOfRoute = (entry: Route) =>
    Route.match(entry, {
      Section: ({ id }) => sections.find((candidate) => candidate.id === id)?.title ?? id,
      Artist: ({ hint }) => hint,
      Album: ({ hint }) => hint,
      Playlist: ({ hint }) => hint,
      NowPlaying: () => "Now playing",
    });
  const breadcrumb = routes.place.trail.map(titleOfRoute).join("  ›  ");
  const showNowPlaying = () => {
    if (!nowPlaying) routes.push(Route.cases.NowPlaying.make({}));
  };
  const playlistActions = usePlaylistActions({
    atoms: props.atoms,
    replica: props.replica,
    run: props.run,
  });
  const libraryMarks = useLibraryMarks({ replica: props.replica, run: props.run });

  const main = useRef<BoxRenderable | null>(null);
  const [downloadQuality, setDownloadQuality] = useState(props.downloadQuality);
  const backdrop = useBackdrop(player.current?.source);

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

  const [reloads, setReloads] = useState(0);
  const reload = () => setReloads((count) => count + 1);

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

  const openArtist = (ref: ArtistRef, name: string | null) =>
    routes.push(Route.cases.Artist.make({ ref, hint: name ?? "Unknown artist" }));

  const openAlbum = (ref: AlbumRef, title: string | null, artistRef: ArtistRef | null) =>
    routes.push(Route.cases.Album.make({ ref, hint: title ?? "Unknown album", artistRef }));

  const openPlaylist = (id: string, name: string) =>
    routes.push(Route.cases.Playlist.make({ id, hint: name }));

  const openSection = (target: Section) => routes.open(target.id);

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

  // The video plays with its own audio, so a song that does not play yet starts first
  const watchVideo = (item: SongItem) => {
    const current = player.current?.source.id === item.source.id;
    if (current && !item.source.video) {
      toast("notice", "This track has no video");
      return;
    }
    if (!current) item.play();
    backdrop.watchVideo();
    showNowPlaying();
  };

  const actionApp = new ActionApp({
    atoms: props.atoms,
    replica: props.replica,
    client,
    run: props.run,
    player,
    route,
    segments,
    downloads: props.downloads,
    downloadQuality,
    openArtist,
    openAlbum,
    searchFor,
    watchVideo,
  });
  const itemActions = useItemActions(actionApp);
  const downloadAction = useDownloadAction(actionApp);

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
      commands.providerOrder,
      () =>
        dialog.push(
          <ProviderOrderDialog
            atoms={props.atoms}
            setOrder={(order) =>
              props.run(props.replica.setProviderOrder({ providerRanking: order }))
            }
          />,
        ),
    ],
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
            group={player.group}
            setVolume={player.setOutputVolume}
          />,
        ),
    ],
    [
      commands.rooms,
      () =>
        dialog.push(
          <RoomsDialog session={props.session} run={props.run} select={player.selectRoom} />,
        ),
    ],
    [commands.queue, () => enterSectionOf(commands.queue)],
    [commands.search, () => enterSectionOf(commands.search)],
    [commands.nextSection, () => moveSection(1)],
    [commands.previousSection, () => moveSection(-1)],
    [commands.nowPlaying, () => (nowPlaying ? routes.back() : showNowPlaying())],
    [
      commands.visualizer,
      () => {
        backdrop.showOnly(!nowPlaying || backdrop.overlay !== "none");
        showNowPlaying();
      },
    ],
    [commands.reload, reload],
    [commands.togglePause, player.togglePause],
    [commands.next, () => player.skip(1, segments)],
    [commands.previous, () => player.skip(-1, segments)],
    [commands.seekBack, () => player.seekBy(-player.seekStepMs)],
    [commands.seekForward, () => player.seekBy(player.seekStepMs)],
    [commands.volumeUp, () => player.changeVolume(1)],
    [commands.volumeDown, () => player.changeVolume(-1)],
    [commands.shuffle, player.toggleShuffle],
    [commands.repeat, player.cycleRepeat],
  ];

  // The keys of the screen come first
  useCommands(playbackCommands, { target: main, targetMode: "focus" });

  const showSidebar = screen.width >= sidebarMinWidth;
  const showPanel = screen.width >= panelMinWidth && screen.height >= 24;
  const panelWidth = Math.min(50, Math.floor(screen.width * 0.32));
  const showHeader = !nowPlaying || backdrop.overlay !== "none";
  const bodyHeight = screen.height - (showHeader ? 4 : 3);

  const cover = useCoverVideo({
    source: player.current?.source,
    // The backdrop shows the video, so the cover does not
    video: !nowPlaying || backdrop.style !== "video",
    artwork,
    playing: player.state === "playing",
    positionMs: player.position,
    connection: client,
    serverUrl: props.serverUrl,
  });

  const app = new ScreenApp({
    serverUrl: props.serverUrl,
    atoms: props.atoms,
    replica: props.replica,
    client,
    run: props.run,
    player,
    search,
    router: routes,
    breadcrumb,
    main,
    segments,
    currentSegment,
    downloads: props.downloads,
    itemActions,
    downloadAction,
    playlistActions,
    libraryMarks,
    backdrop,
    showNowPlaying,
    artwork,
    cover,
    width: screen.width,
    bodyHeight,
    reloads,
    openArtist,
    openAlbum,
    openPlaylist,
    watchVideo,
  });

  // `sections` never changes, so each render calls the same hooks in the same order
  const views = new Map(sections.map((entry) => [entry, entry.useView(app)] as const));
  // A route holds only sections from `sections`
  const sectionView = views.get(section)!;

  return (
    <box
      ref={main}
      focusable
      flexDirection="column"
      width="100%"
      height="100%"
      backgroundColor={theme.background}
    >
      {showHeader && (
        <Header
          sections={showSidebar || nowPlaying ? [] : sections}
          active={section.id}
          server={showSidebar ? props.serverUrl : null}
          status={status}
        />
      )}
      {nowPlaying && <NowPlayingScreen app={app} />}
      {!nowPlaying && (
        <box flexDirection="row" flexGrow={1}>
          {showSidebar && (
            <Sidebar
              sections={sections}
              count={(entry) => views.get(entry)?.count ?? 0}
              active={section}
              onSelect={enterSection}
            />
          )}
          <box flexDirection="column" flexGrow={1} paddingX={1} paddingTop={1}>
            {Route.match(route, {
              Section: () => sectionView.render(),
              Artist: (page) => <PageScreen app={app} route={page} />,
              Album: (page) => <PageScreen app={app} route={page} />,
              Playlist: (playlist) => <PlaylistScreen app={app} route={playlist} />,
              NowPlaying: () => null,
            })}
          </box>
          {showPanel && (
            <NowPlayingPanel
              entry={player.current}
              segment={segments[currentSegment]}
              upNext={upNextOf(player)}
              cover={cover.render}
              width={panelWidth}
              height={bodyHeight}
              onOpen={showNowPlaying}
            />
          )}
        </box>
      )}
      <Footer
        entry={player.current}
        state={player.state}
        positionMs={player.position()}
        durationMs={player.durationMs()}
        segments={segments}
        currentSegment={currentSegment}
        volume={player.volume}
        muted={player.muted}
        quality={player.quality()}
        shuffle={player.shuffle}
        repeat={player.repeat}
        message={
          player.error ??
          player.offline ??
          (player.lost ? "The output does not answer" : null) ??
          (player.room === null ? null : `Room ${player.room}`)
        }
        artwork={artwork}
        showCover={nowPlaying ? backdrop.overlay !== "full" : !showPanel}
        onOpen={showNowPlaying}
        onSeek={player.seekTo}
        onVolume={player.setVolume}
      />
    </box>
  );
}
