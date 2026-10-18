import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { clientPlugins, isPluginEnabled, withEnabled } from "../context/plugin-host.ts";
import { loadSettings, updateSettings } from "../context/settings.ts";
import { fail } from "./auth.ts";

const pluginsCommand = Command.make("plugins", {}, () =>
  Effect.gen(function* () {
    const settings = yield* loadSettings;
    for (const plugin of clientPlugins) {
      const state = isPluginEnabled(settings, plugin) ? "on" : "off";
      yield* Console.log(`${plugin.id}  ${plugin.name}: ${state}`);
    }
  }),
).pipe(Command.withDescription("List the plugins of this device"));

const changePlugin = (id: string, enable: boolean) =>
  Effect.gen(function* () {
    const plugin = clientPlugins.find((candidate) => candidate.id === id);
    if (plugin === undefined) {
      return yield* fail(
        `Unknown plugin. Use one of: ${clientPlugins.map((candidate) => candidate.id).join(", ")}`,
      );
    }

    yield* updateSettings((settings) => withEnabled(settings, id, enable));
    yield* Console.log(enable ? plugin.notice : `${plugin.name} off`);
  });

const enableCommand = Command.make("enable", { id: Argument.String("plugin") }, ({ id }) =>
  changePlugin(id, true),
).pipe(Command.withDescription("Turn on a plugin for this device"));

const disableCommand = Command.make("disable", { id: Argument.String("plugin") }, ({ id }) =>
  changePlugin(id, false),
).pipe(Command.withDescription("Turn off a plugin for this device"));

export const pluginCommands = [
  pluginsCommand.pipe(Command.withSubcommands([enableCommand, disableCommand])),
] as const;
