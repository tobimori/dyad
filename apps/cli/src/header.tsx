import type { Theme } from "./theme.ts";

/** The name, the sections when the sidebar is hidden, and the server status */
export function Header<S extends string>(props: {
  readonly sections: ReadonlyArray<{ readonly id: S; readonly label: string }>;
  readonly active: S;
  readonly status: string;
  readonly theme: Theme;
}) {
  return (
    <box flexDirection="row" height={1} paddingX={1} gap={2}>
      <text flexGrow={1} wrapMode="none">
        <strong fg={props.theme.accent}>dyad</strong>
        {props.sections.map((section) => (
          <span
            key={section.id}
            fg={section.id === props.active ? props.theme.accent : props.theme.muted}
          >{`   ${section.label}`}</span>
        ))}
      </text>
      <text fg={props.theme.faint}>{props.status}</text>
    </box>
  );
}

export function SearchField(props: {
  readonly query: string;
  readonly focused: boolean;
  readonly theme: Theme;
  readonly onFocus: () => void;
  readonly onInput: (query: string) => void;
  readonly onSubmit: () => void;
}) {
  const theme = props.theme;

  return (
    <box
      flexDirection="row"
      height={1}
      marginBottom={1}
      paddingX={1}
      backgroundColor={props.focused ? theme.selection : theme.panel}
      onMouseDown={props.onFocus}
    >
      <text width={2} fg={theme.accent}>
        /
      </text>
      <input
        flexGrow={1}
        focused={props.focused}
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
        onSubmit={props.onSubmit}
      />
    </box>
  );
}
