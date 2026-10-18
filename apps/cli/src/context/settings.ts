import { DownloadQuality } from "@dyad/domain";
import { Effect, FileSystem, Path, Schema } from "effect";
import envPaths from "env-paths";

/** Not synced, because a setting such as a plugin can concern only this device */
export class Settings extends Schema.Class<Settings>("Settings")({
  enabledPlugins: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** The volume of this device as an output. Missing until it first changes. */
  volume: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /** For downloads that do not choose their own. Missing until it first changes. */
  downloadQuality: Schema.optionalKey(DownloadQuality),
}) {}

const SettingsJson = Schema.fromJsonString(Settings);

const settingsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(envPaths("dyad", { suffix: "" }).config, "settings.json");
});

export const loadSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* settingsFile;
  const exists = yield* fs.exists(file);
  if (!exists) return new Settings({ enabledPlugins: [] });

  const text = yield* fs.readFileString(file);
  return yield* Schema.decodeEffect(SettingsJson)(text);
});

/** Reads the file first, so that two writers of different settings do not undo each other */
export const updateSettings = (change: (settings: Settings) => Settings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const file = yield* settingsFile;
    // A broken file must not stop the player. This write replaces it.
    const settings = yield* loadSettings.pipe(
      Effect.orElseSucceed(() => new Settings({ enabledPlugins: [] })),
    );

    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(SettingsJson)(change(settings)));
  });
