import { useTheme } from "./theme.ts";

/** The sections, with the active one marked */
export function Sidebar<S extends string>(props: {
  readonly sections: ReadonlyArray<{
    readonly id: S;
    readonly label: string;
    readonly count: number;
  }>;
  readonly active: S;
  readonly onSelect: (section: S) => void;
}) {
  const theme = useTheme();

  return (
    <box width={22} flexDirection="column" backgroundColor={theme.panel} paddingY={1}>
      {props.sections.map((section) => {
        const active = section.id === props.active;
        return (
          <box
            key={section.id}
            flexDirection="row"
            height={1}
            paddingRight={1}
            backgroundColor={active ? theme.selection : "transparent"}
            onMouseDown={() => props.onSelect(section.id)}
          >
            <text width={2} fg={theme.accent}>
              {active ? "▌" : " "}
            </text>
            <text flexGrow={1} fg={active ? theme.text : theme.muted}>
              {active ? <strong>{section.label}</strong> : section.label}
            </text>
            <text fg={theme.faint}>{section.count === 0 ? "" : String(section.count)}</text>
          </box>
        );
      })}
    </box>
  );
}
