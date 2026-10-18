import { DownloadQuality } from "@dyad/domain";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, FileSystem, Path, Schema } from "effect";
import envPaths from "env-paths";
import { useEffect, useState } from "react";

/** An effect behind the now playing view; the names are the keys of `backdrops` */
export const BackdropEffect = Schema.Literals(["artwork", "aura", "pulse", "embers", "horizon"]);

/** What fills the now playing view: an effect, the visualizer presets, the video or nothing */
export const Backdrop = Schema.Literals([...BackdropEffect.literals, "visualizer", "video", "off"]);

/** What the now playing view draws over the backdrop */
export const Overlay = Schema.Literals(["full", "details", "none"]);

/** Not synced, because a setting such as a plugin can concern only this device */
export class Settings extends Schema.Class<Settings>("Settings")({
  enabledPlugins: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  disabledPlugins: Schema.Array(Schema.String).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  /** The volume of this device as an output. Missing until it first changes. */
  volume: Schema.optionalKey(Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }))),
  /** For downloads that do not choose their own. Missing until it first changes. */
  downloadQuality: Schema.optionalKey(DownloadQuality),
  /** Shows video this much later, for audio outputs with latency such as Bluetooth headphones */
  videoDelayMs: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: -2000, maximum: 2000 })),
  ),
  /** `false` shows the cover instead of the muted video of the source. Missing means on. */
  coverVideo: Schema.optionalKey(Schema.Boolean),
  backdrop: Schema.optionalKey(Backdrop),
  overlay: Schema.optionalKey(Overlay),
}) {}

export const defaultSettings = new Settings({ enabledPlugins: [], disabledPlugins: [] });

const SettingsJson = Schema.fromJsonString(Settings);

const settingsFile = Effect.gen(function* () {
  const path = yield* Path.Path;
  return path.join(envPaths("dyad", { suffix: "" }).config, "settings.json");
});

export const loadSettings = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const file = yield* settingsFile;
  const exists = yield* fs.exists(file);
  if (!exists) return defaultSettings;

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
    const settings = yield* loadSettings.pipe(Effect.orElseSucceed(() => defaultSettings));

    yield* fs.makeDirectory(path.dirname(file), { recursive: true });
    yield* fs.writeFileString(file, yield* Schema.encodeEffect(SettingsJson)(change(settings)));
  });

/** `null` until the file loads. It loads on each mount, so that a change elsewhere applies. */
export const useSettings = () => {
  const [settings, setSettings] = useState<Settings | null>(null);
  useEffect(() => {
    const loading = Effect.runFork(
      loadSettings.pipe(
        Effect.orElseSucceed(() => defaultSettings),
        Effect.tap((loaded) => Effect.sync(() => setSettings(loaded))),
        Effect.provide(NodeServices.layer),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(loading));
    };
  }, []);
  return [settings, setSettings] as const;
};
