import type { ClientPlugin } from "@dyad/plugin/client";
import type { BoxRenderable, ScrollBoxRenderable } from "@opentui/core";
import { useTerminalDimensions } from "@opentui/react";
import { Data } from "effect";
import type { Effect, Fiber } from "effect";
import { useEffect, useRef, useState } from "react";

import { Dialog, useDialog } from "./dialog.tsx";
import { commands, helpColumns, keyLabel, useCommands } from "./keymap.ts";
import type { Command } from "./keymap.ts";
import type { PluginHost } from "./plugins.ts";
import { SelectList, SelectOption } from "./select-list.tsx";
import { useTheme } from "./theme.ts";
import { useToast } from "./toast.tsx";

/** A command for one track, with a label that can name the artist or the album */
export class Action extends Data.Class<{
  readonly command: Command;
  readonly label: string;
  readonly run: () => void;
}> {}

const actionsWidth = 56;

export function ActionsDialog(props: {
  readonly title: string;
  readonly actions: ReadonlyArray<Action>;
}) {
  const dialog = useDialog();
  const options = props.actions.map(
    (action) =>
      new SelectOption({
        value: action.command.id,
        title: action.label,
        detail: action.command.keys[0] === undefined ? "" : keyLabel(action.command.keys[0]),
      }),
  );

  const run = (id: string) => {
    dialog.pop();
    props.actions.find((action) => action.command.id === id)?.run();
  };

  return (
    <Dialog title={props.title} width={actionsWidth}>
      <SelectList options={options} width={actionsWidth - 4} rows={12} onChoose={run} />
    </Dialog>
  );
}

const pluginsWidth = 48;

/** Turns the plugins of this device on and off. It stays open, so that the user sees the change. */
export function PluginsDialog(props: {
  readonly host: PluginHost;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const toast = useToast();
  const [enabled, setEnabled] = useState(() =>
    props.host.plugins.filter((plugin) => props.host.isEnabled(plugin.id)),
  );

  const options = props.host.plugins.map(
    (plugin) =>
      new SelectOption({
        value: plugin,
        title: plugin.name,
        detail: enabled.includes(plugin) ? "on" : "off",
      }),
  );

  const toggle = (plugin: ClientPlugin) => {
    const enable = !enabled.includes(plugin);
    setEnabled(enable ? [...enabled, plugin] : enabled.filter((other) => other !== plugin));

    props.run(props.host.setEnabled(plugin.id, enable));
    toast("notice", enable ? plugin.notice : `${plugin.name} off`);
  };

  return (
    <Dialog title="Plugins" width={pluginsWidth}>
      <SelectList options={options} width={pluginsWidth - 4} rows={12} onChoose={toggle} />
    </Dialog>
  );
}

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
