import { useTheme } from "../theme/theme.ts";

export function Sidebar<S extends { readonly id: string; readonly title: string }>(props: {
  readonly sections: ReadonlyArray<S>;
  readonly count: (section: S) => number;
  readonly active: S;
  readonly onSelect: (section: S) => void;
}) {
  const theme = useTheme();

  return (
    <box width={22} flexDirection="column" backgroundColor={theme.panel} paddingY={1}>
      {props.sections.map((section) => {
        const active = section === props.active;
        const count = props.count(section);
        return (
          <box
            key={section.id}
            flexDirection="row"
            height={1}
            paddingRight={1}
            backgroundColor={active ? theme.selection : "transparent"}
            onMouseDown={() => props.onSelect(section)}
          >
            <text width={2} fg={theme.accent}>
              {active ? "▌" : " "}
            </text>
            <text flexGrow={1} fg={active ? theme.text : theme.muted}>
              {active ? <strong>{section.title}</strong> : section.title}
            </text>
            <text fg={theme.faint}>{count === 0 ? "" : String(count)}</text>
          </box>
        );
      })}
    </box>
  );
}
