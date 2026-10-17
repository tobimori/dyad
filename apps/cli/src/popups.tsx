import { Data } from "effect";
import type { ReactNode } from "react";

import { fit } from "./format.ts";
import { helpColumns } from "./keys.ts";
import type { Theme } from "./theme.ts";

export class Action extends Data.Class<{
  readonly label: string;
  readonly run: () => void;
}> {}

const actionsWidth = 52;

// A centered box above the rest of the screen
function Popup(props: {
  readonly title: string;
  readonly width: number;
  readonly height: number;
  readonly screen: { readonly width: number; readonly height: number };
  readonly theme: Theme;
  readonly children: ReactNode;
}) {
  const width = Math.min(props.width, props.screen.width - 2);
  const height = Math.min(props.height, props.screen.height - 2);

  return (
    <box
      position="absolute"
      zIndex={10}
      left={Math.floor((props.screen.width - width) / 2)}
      top={Math.floor((props.screen.height - height) / 2)}
      width={width}
      height={height}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={props.theme.accent}
      backgroundColor={props.theme.panel}
      title={` ${props.title} `}
      titleColor={props.theme.text}
      paddingX={1}
    >
      {props.children}
    </box>
  );
}

export function ActionsPopup(props: {
  readonly title: string;
  readonly actions: ReadonlyArray<Action>;
  readonly selected: number;
  readonly screen: { readonly width: number; readonly height: number };
  readonly theme: Theme;
  readonly onRun: (index: number) => void;
}) {
  return (
    <Popup
      title={props.title}
      width={actionsWidth}
      height={props.actions.length + 2}
      screen={props.screen}
      theme={props.theme}
    >
      {props.actions.map((action, index) => {
        const selected = index === props.selected;
        return (
          <box
            key={action.label}
            height={1}
            backgroundColor={selected ? props.theme.selection : "transparent"}
            onMouseDown={() => props.onRun(index)}
          >
            <text wrapMode="none" fg={selected ? props.theme.text : props.theme.muted}>
              <span fg={props.theme.accent}>{selected ? "› " : "  "}</span>
              {fit(action.label, actionsWidth - 6)}
            </text>
          </box>
        );
      })}
    </Popup>
  );
}

export function HelpPopup(props: {
  readonly screen: { readonly width: number; readonly height: number };
  readonly theme: Theme;
}) {
  // Each group has a blank row and a heading above its keys
  const columnRows = helpColumns.map((groups) =>
    groups.reduce((rows, [, keys]) => rows + keys.length + 2, 0),
  );

  return (
    <Popup
      title="Keys"
      width={74}
      height={Math.max(...columnRows) + 2}
      screen={props.screen}
      theme={props.theme}
    >
      <box flexDirection="row" gap={2}>
        {helpColumns.map((groups) => (
          <box key={groups[0][0]} flexDirection="column" flexGrow={1} flexBasis={0}>
            {groups.map(([group, keys]) => (
              <box key={group} flexDirection="column" marginTop={1}>
                <text fg={props.theme.accent}>
                  <strong>{group}</strong>
                </text>
                {keys.map(([key, label]) => (
                  <box key={key} flexDirection="row" height={1}>
                    <text width={12} fg={props.theme.text}>
                      {key}
                    </text>
                    <text wrapMode="none" fg={props.theme.muted}>
                      {label}
                    </text>
                  </box>
                ))}
              </box>
            ))}
          </box>
        ))}
      </box>
    </Popup>
  );
}
