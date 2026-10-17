import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { useEffect, useRef } from "react";

import { commands, helpColumns, keyLabel, useCommands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";

const keyColumnWidth = 10;

/** All commands with their keys, by group. On a small screen, the arrow keys scroll it. */
export function HelpDialog() {
  const theme = useTheme();
  const dialog = useDialog();
  const screen = useTerminalDimensions();
  const content = useRef<BoxRenderable | null>(null);
  const scroll = useRef<ScrollBoxRenderable | null>(null);

  const all = Object.values(commands).filter((entry) => entry.keys.length > 0);
  // Each group has a blank row and a heading above its commands
  const rows = Math.max(
    ...helpColumns.map((groups) =>
      groups.reduce(
        (total, group) => total + 2 + all.filter((entry) => entry.group === group).length,
        0,
      ),
    ),
  );

  useCommands(
    [
      [commands.selectUp, () => scroll.current?.scrollBy(-1)],
      [commands.selectDown, () => scroll.current?.scrollBy(1)],
      [commands.help, dialog.pop],
    ],
    { target: content, targetMode: "focus" },
  );

  useEffect(() => {
    content.current?.focus();
  }, []);

  return (
    <Dialog title="Keys" width={84}>
      <box ref={content} focusable flexDirection="column">
        <scrollbox ref={scroll} focusable={false} height={Math.min(rows, screen.height - 4)}>
          <box flexDirection="row" gap={2}>
            {helpColumns.map((groups) => (
              <box key={groups.join()} flexDirection="column" flexGrow={1} flexBasis={0}>
                {groups.map((group) => (
                  <box key={group} flexDirection="column" marginTop={1}>
                    <text fg={theme.accent}>
                      <strong>{group}</strong>
                    </text>
                    {all
                      .filter((entry) => entry.group === group)
                      .map((entry) => (
                        <box key={entry.id} flexDirection="row" height={1}>
                          <text width={keyColumnWidth} wrapMode="none" fg={theme.text}>
                            {entry.keys.map(keyLabel).join(" ")}
                          </text>
                          <text wrapMode="none" fg={theme.muted}>
                            {entry.title}
                          </text>
                        </box>
                      ))}
                  </box>
                ))}
              </box>
            ))}
          </box>
        </scrollbox>
      </box>
    </Dialog>
  );
}
