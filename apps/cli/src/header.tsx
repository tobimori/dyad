import type { InputRenderable } from "@opentui/core";
import type { RefObject } from "react";

import { commands, useCommands } from "./keymap.ts";
import { useTheme } from "./theme.ts";

const statusText = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
};

/** The name, the sections when the sidebar is hidden, and the connection */
export function Header<S extends string>(props: {
  readonly sections: ReadonlyArray<{ readonly id: S; readonly label: string }>;
  readonly active: S | null;
  readonly server: string | null;
  readonly status: keyof typeof statusText;
}) {
  const theme = useTheme();
  const status = statusText[props.status];

  return (
    <box flexDirection="row" height={1} paddingX={1} gap={2}>
      <text flexGrow={1} wrapMode="none">
        <strong fg={theme.accent}>dyad</strong>
        {props.sections.map((section) => (
          <span
            key={section.id}
            fg={section.id === props.active ? theme.accent : theme.muted}
          >{`   ${section.label}`}</span>
        ))}
      </text>
      <text wrapMode="none">
        <span fg={theme.faint}>{props.server === null ? "" : `${props.server} · `}</span>
        <span fg={props.status === "connected" ? theme.faint : theme.accent}>{status}</span>
      </text>
    </box>
  );
}

/** The search text field. It has its own keys, so that all letters stay text while it has focus. */
export function SearchField(props: {
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
