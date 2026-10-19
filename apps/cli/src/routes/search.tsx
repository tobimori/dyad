import type { InputRenderable } from "@opentui/core";
import { useEffect, useMemo, useRef, useState } from "react";
import type { RefObject } from "react";

import { useListScreen } from "../component/list-screen.tsx";
import { TrackList, listItems, playsSource } from "../component/track-list.tsx";
import type { TrackItem } from "../component/track-list.tsx";
import { commands, useCommands } from "../context/keymap.ts";
import { Section, SectionView } from "../context/routes.ts";
import type { ScreenApp } from "../context/screen-app.ts";
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

function SearchScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<TrackItem>;
  readonly input: RefObject<InputRenderable | null>;
}) {
  const { app, input } = props;
  const list = useListScreen(app, { title, items: props.items });

  const { status, query } = app.search;
  return (
    <>
      <SearchField
        input={input}
        query={query}
        onInput={app.search.search}
        onLeave={() => app.main.current?.focus()}
      />
      <TrackList
        title={status === null ? title : `${title}  ·  ${status}`}
        items={props.items}
        selected={list.selected}
        playing={playsSource(app.player.current?.source.id)}
        historyRows={0}
        empty={query.trim() === "" ? "Type to search the library and the providers" : ""}
        onSelect={list.select}
        onActivate={list.activate}
      />
    </>
  );
}

export const search = new Section({
  id: "search",
  title,
  order: 10,
  command: commands.search,
  useView: (app) => {
    const input = useRef<InputRenderable | null>(null);
    const [focus, setFocus] = useState(false);
    const results = app.search.results;
    const items = useMemo(() => listItems(results, "search"), [results]);

    // The search field exists only after the render that shows the search section
    useEffect(() => {
      if (!focus) return;
      input.current?.focus();
      setFocus(false);
    }, [focus]);

    return new SectionView({
      count: items.length,
      focus: () => setFocus(true),
      render: () => <SearchScreen app={app} items={items} input={input} />,
    });
  },
});
