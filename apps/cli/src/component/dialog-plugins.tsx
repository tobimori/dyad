import type { ClientPlugin } from "@dyad/plugin/client";
import type { Effect, Fiber } from "effect";
import { useState } from "react";

import type { PluginHost } from "../context/plugin-host.ts";
import { Dialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";

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
