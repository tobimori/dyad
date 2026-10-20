import { providerName } from "@dyad/client-runtime";
import { PageTrack } from "@dyad/domain";
import type { SearchResults } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import type { InputRenderable } from "@opentui/core";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { useListScreen } from "../component/list-screen.tsx";
import {
  PlaylistRow,
  RowList,
  albumRows,
  artistRows,
  headed,
  selectableRows,
  trackRows,
} from "../component/row-list.tsx";
import type { Row } from "../component/row-list.tsx";
import { commands, useCommands } from "../context/keymap.ts";
import { Section, SectionView } from "../context/routes.ts";
import type { ScreenApp } from "../context/screen-app.ts";
import { useLibraryStatus } from "./library/library-notice.tsx";
import { useTheme } from "../theme/theme.ts";

/** It has its own keys, so that all letters stay text while it has focus */
function SearchField(props: {
  readonly input: RefObject<InputRenderable | null>;
  readonly query: string;
  readonly onInput: (query: string) => void;
  readonly onLeave: () => void;
}) {
  const theme = useTheme();

  useCommands(
    [
      [commands.leaveInput, props.onLeave],
      [commands.submitInput, props.onLeave],
    ],
    { target: props.input, targetMode: "focus" },
  );

  return (
    <box
      flexDirection="row"
      height={1}
      marginBottom={1}
      paddingX={1}
      backgroundColor={theme.panel}
      onMouseDown={(event) => {
        // Without this, the renderer moves the focus to the next focusable parent
        event.preventDefault();
        props.input.current?.focus();
      }}
    >
      <text width={2} fg={theme.accent}>
        /
      </text>
      <input
        ref={props.input}
        flexGrow={1}
        value={props.query}
        placeholder="Search the library and the providers"
        maxLength={200}
        backgroundColor={theme.panel}
        focusedBackgroundColor={theme.selection}
        textColor={theme.text}
        focusedTextColor={theme.text}
        placeholderColor={theme.faint}
        cursorColor={theme.accent}
        onInput={props.onInput}
      />
    </box>
  );
}

const title = "Search";
const topSongs = 8;

// An artist with exactly the name of the query comes first, else the songs
const resultRows = (
  query: string,
  results: SearchResults,
  playlists: ReadonlyArray<PlaylistRow>,
) => {
  const tracks = results.sources.map(
    (source) => new PageTrack({ source, disc: null, number: null, playable: true }),
  );
  const songs = trackRows("song", tracks, "search");
  const wanted = query.trim().toLowerCase();
  const artistFirst = results.artists[0]?.name.toLowerCase() === wanted;
  const sections = [
    ...(artistFirst ? [["artists", "Artists", artistRows(results.artists)] as const] : []),
    ["songs", "Songs", songs.slice(0, topSongs)] as const,
    ...(artistFirst ? [] : [["artists", "Artists", artistRows(results.artists)] as const]),
    ["albums", "Albums", albumRows(results.albums)] as const,
    ["playlists", "Your playlists", playlists] as const,
    ["more", "More songs", songs.slice(topSongs)] as const,
  ].filter(([, , rows]) => rows.length > 0);
  return sections.flatMap(([key, label, rows], index) => headed(key, label, index === 0, rows));
};

function SearchScreen(props: {
  readonly app: ScreenApp;
  readonly rows: ReadonlyArray<Row>;
  readonly input: RefObject<InputRenderable | null>;
}) {
  const { app, input } = props;
  const theme = useTheme();
  const items = useMemo(() => selectableRows(props.rows), [props.rows]);
  const list = useListScreen(app, { title, items });

  const { status, query } = app.search;
  return (
    <>
      <SearchField
        input={input}
        query={query}
        onInput={app.search.search}
        onLeave={() => app.main.current?.focus()}
      />
      {status !== null && (
        <text fg={theme.muted} paddingX={1} marginBottom={1} flexShrink={0}>
          {status}
        </text>
      )}
      <RowList
        rows={props.rows}
        selected={list.selectedKey}
        playingId={app.player.current?.source.id ?? null}
        empty={
          query.trim() === "" ? "Type to search songs, artists, albums and your playlists" : ""
        }
        onSelect={list.selectRow}
        onActivate={list.activateRow}
      />
    </>
  );
}

export const search = new Section({
  id: "search",
  title,
  order: 10,
  group: null,
  command: commands.search,
  useView: (app) => {
    const input = useRef<InputRenderable | null>(null);
    const [focus, setFocus] = useState(false);
    const { results, query } = app.search;
    const playlistResult = useAtomValue(app.atoms.playlists);
    const { names } = useLibraryStatus(app.atoms);
    // Playlists are on the device, so they show at once, also offline
    const playlists = useMemo(() => {
      const wanted = query.trim().toLowerCase();
      if (wanted === "" || !AsyncResult.isSuccess(playlistResult)) return [];
      return playlistResult.value.flatMap((playlist) =>
        playlist.name.toLowerCase().includes(wanted)
          ? [
              new PlaylistRow({
                key: `playlist:${playlist.id}`,
                playlist,
                providerName:
                  playlist.link === null ? null : providerName(names, playlist.link.provider),
              }),
            ]
          : [],
      );
    }, [query, playlistResult, names]);
    const rows = useMemo(() => resultRows(query, results, playlists), [query, results, playlists]);

    // The search field exists only after the render that shows the search section
    useEffect(() => {
      if (!focus) return;
      input.current?.focus();
      setFocus(false);
    }, [focus]);

    return new SectionView({
      count: results.sources.length,
      focus: () => setFocus(true),
      render: () => <SearchScreen app={app} rows={rows} input={input} />,
    });
  },
});
