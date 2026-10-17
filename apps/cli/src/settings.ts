import { Effect, FileSystem, Path, Schema } from "effect";
import envPaths from "env-paths";

/**
 * Settings of this device. They are not synced, because a setting such as a plugin can concern
 * only this device.
 */
export class Settings extends Schema.Class<Settings>("Settings")({
  /** Client plugins are off until the user turns them on */
  enabledPlugins: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
}) {}

const SettingsJson = Schema.fromJsonString(Settings);

const settingsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(envPaths("dyad", { suffix: "" }).config, "settings.json");
});

/** A missing file gives the defaults */
export const loadSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* settingsFile;
  const exists = yield* fs.exists(file);
  if (!exists) return new Settings({ enabledPlugins: [] });

  const text = yield* fs.readFileString(file);
  return yield* Schema.decodeEffect(SettingsJson)(text);
});

export const saveSettings = (settings: Settings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* settingsFile;

    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(SettingsJson)(settings));
  });
