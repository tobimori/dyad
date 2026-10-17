import { useTheme } from "../theme/theme.ts";

const statusText = {
  connecting: "Connecting…",
  connected: "Connected",
  reconnecting: "Reconnecting…",
};

export function Header(props: {
  readonly sections: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly active: string;
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
          >{`   ${section.title}`}</span>
        ))}
      </text>
      <text wrapMode="none">
        <span fg={theme.faint}>{props.server === null ? "" : `${props.server} · `}</span>
        <span fg={props.status === "connected" ? theme.faint : theme.accent}>{status}</span>
      </text>
    </box>
  );
}
