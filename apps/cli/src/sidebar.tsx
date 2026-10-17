import type { Theme } from "./theme.ts";

/** The sections, with the active one marked */
export function Sidebar<S extends string>(props: {
  readonly sections: ReadonlyArray<{
    readonly id: S;
    readonly label: string;
    readonly count: number;
  }>;
  readonly active: S;
  readonly theme: Theme;
  readonly onSelect: (section: S) => void;
}) {
  return (
    <box width={22} flexDirection="column" backgroundColor={props.theme.panel} paddingY={1}>
      {props.sections.map((section) => {
        const active = section.id === props.active;
        return (
          <box
            key={section.id}
            flexDirection="row"
            height={1}
            paddingRight={1}
            backgroundColor={active ? props.theme.selection : "transparent"}
            onMouseDown={() => props.onSelect(section.id)}
          >
            <text width={2} fg={props.theme.accent}>
              {active ? "▌" : " "}
            </text>
            <text flexGrow={1} fg={active ? props.theme.text : props.theme.muted}>
              {active ? <strong>{section.label}</strong> : section.label}
            </text>
            <text fg={props.theme.faint}>{section.count === 0 ? "" : String(section.count)}</text>
          </box>
        );
      })}
    </box>
  );
}
