// OpenTUI 0.6.6 resolves its native library in a top-level await, so this import must be first
import "./sea-assets.ts";

import {
  Downloads,
  SessionClient,
  downloadsLayer,
  serverAtoms,
  serverConnectionLayer,
  sessionClientLayer,
} from "@dyad/client-runtime";
import type { DownloadQuality } from "@dyad/domain";
import { ClientPluginContext } from "@dyad/plugin/client";
import { RegistryProvider } from "@effect/atom-react";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createCliRenderer, setupAudio } from "@opentui/core";
import { KeymapProvider } from "@opentui/keymap/react";
import { createRoot } from "@opentui/react";
import { Cause, Context, Data, Effect, FileSystem, Layer, Option, Path } from "effect";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import envPaths from "env-paths";

import { App } from "./app.tsx";
import { accountCommands } from "./commands/accounts.ts";
import {
  authCommands,
  deviceToken,
  reportFailures,
  serverUrl as serverUrlConfig,
} from "./commands/auth.ts";
import { pluginCommands } from "./commands/plugins.ts";
import { createKeymap } from "./context/keymap.ts";
import { startPluginHost } from "./context/plugin-host.ts";
import { openPlayLog } from "./context/play-log.ts";
import { importSavedSession, savedVolume } from "./context/session.ts";
import { Settings, loadSettings, updateSettings } from "./context/settings.ts";
import { ThemeProvider } from "./context/theme-provider.tsx";
import { fileLogging, processErrorLogging } from "./log.ts";
import { Engine, engineLayer } from "./playback/engine.ts";
import { capabilities } from "./playback/player.ts";
import { DialogProvider } from "./ui/dialog.tsx";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import { ToastProvider } from "./ui/toast.tsx";

class RendererError extends Data.TaggedError("RendererError")<{ readonly cause: unknown }> {}

/** With `controller`, this device opens no audio and only controls the session */
const player = (controller: boolean) =>
  Effect.gen(function* () {
    const logging = yield* fileLogging;
    const logServices = yield* Layer.build(logging);
    const run = Effect.runForkWith(logServices);
    yield* processErrorLogging(logServices);
    const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

    // One connection for the session and the atoms
    const serverUrl = yield* serverUrlConfig;
    const connection = yield* Layer.build(
      serverConnectionLayer(serverUrl, Option.some(yield* deviceToken)).pipe(
        Layer.provide(logging),
      ),
    );

    const settings = yield* loadSettings.pipe(
      Effect.orElseSucceed(() => new Settings({ enabledPlugins: [] })),
    );
    const saveVolume = (value: number) =>
      updateSettings((current) => new Settings({ ...current, volume: value })).pipe(
        Effect.provideContext(services),
        Effect.tapCause((cause) => Effect.logWarning("Cannot save the volume", cause)),
        Effect.provideContext(logServices),
        Effect.ignore,
      );

    // The import of the old session removes its volume, so the volume moves to the settings first
    const saved = settings.volume === undefined ? yield* savedVolume(serverUrl) : Option.none();
    if (Option.isSome(saved)) yield* saveVolume(saved.value);
    const volume = settings.volume ?? Option.getOrElse(saved, () => 1);

    const saveDownloadQuality = (quality: typeof DownloadQuality.Type) =>
      updateSettings((current) => new Settings({ ...current, downloadQuality: quality })).pipe(
        Effect.provideContext(services),
        Effect.tapCause((cause) => Effect.logWarning("Cannot save the download quality", cause)),
        Effect.provideContext(logServices),
        Effect.ignore,
      );

    const playLog = yield* openPlayLog(serverUrl);
    const path = yield* Path.Path;
    const downloads = controller
      ? null
      : Context.get(
          yield* Layer.build(
            downloadsLayer({
              directory: path.join(
                envPaths("dyad", { suffix: "" }).data,
                "downloads",
                encodeURIComponent(serverUrl),
              ),
              serverUrl,
              capabilities,
            }).pipe(
              Layer.provide(Layer.succeedContext(connection)),
              Layer.provide(FetchHttpClient.layer),
              Layer.provide(logging),
            ),
          ),
          Downloads,
        );
    const audio = controller
      ? null
      : yield* Effect.acquireRelease(
          Effect.sync(() => setupAudio()),
          (audio) => Effect.sync(() => audio.dispose()),
        );
    const engine =
      audio === null
        ? null
        : Context.get(
            yield* Layer.build(
              engineLayer({
                audio,
                serverUrl,
                volume,
                saveVolume,
                recordPlay: playLog.add,
                downloads,
              }).pipe(
                Layer.provide(Layer.succeedContext(connection)),
                Layer.provide(FetchHttpClient.layer),
              ),
            ),
            Engine,
          );

    const sessionServices = yield* Layer.build(
      sessionClientLayer({
        player:
          engine === null ? null : { capabilities, volume: engine.volume, resume: engine.resume },
        playLog,
      }).pipe(Layer.provide(Layer.succeedContext(connection)), Layer.provide(logging)),
    );
    const session = Context.get(sessionServices, SessionClient);

    yield* importSavedSession(serverUrl, session).pipe(
      Effect.catchCause((cause) => Effect.logWarning("Cannot import the old session", cause)),
      Effect.provideContext(logServices),
      Effect.forkScoped,
    );

    const atoms = serverAtoms(connection, logging);
    const plugins = yield* startPluginHost(
      new ClientPluginContext({
        serverOrigin: serverUrl,
        playback: { nowPlaying: session.nowPlaying },
      }),
    ).pipe(Effect.provideContext(logServices));

    // The Effect runtime owns process signals. The app handles Ctrl+C as a key, so that it can
    // pause the session before it quits.
    const renderer = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => createCliRenderer({ exitSignals: [], exitOnCtrlC: false }),
        catch: (cause) => new RendererError({ cause }),
      }),
      (renderer) =>
        Effect.tryPromise(() => {
          renderer.destroy();
          return renderer.closed;
        }).pipe(Effect.ignore),
    );

    // Most terminals answer at once. Without an answer, the player uses dark colors.
    const mode = yield* Effect.promise(() => renderer.waitForThemeMode(500));
    const keymap = createKeymap(renderer);

    const logCrash = (cause: unknown, componentStack: string) =>
      run(
        Effect.logError("The app stopped because of an error", Cause.die(cause)).pipe(
          Effect.annotateLogs({ componentStack }),
        ),
      );

    yield* Effect.callback<void>((resume) => {
      renderer.once("destroy", () => resume(Effect.void));
      createRoot(renderer).render(
        <KeymapProvider keymap={keymap}>
          <RegistryProvider>
            <ThemeProvider mode={mode ?? "dark"}>
              <ErrorBoundary onError={logCrash} onQuit={() => renderer.destroy()}>
                <ToastProvider>
                  <DialogProvider>
                    <App
                      serverUrl={serverUrl}
                      atoms={atoms}
                      session={session}
                      engine={engine}
                      run={run}
                      plugins={plugins}
                      downloads={downloads}
                      downloadQuality={settings.downloadQuality ?? "high"}
                      saveDownloadQuality={(quality) => run(saveDownloadQuality(quality))}
                    />
                  </DialogProvider>
                </ToastProvider>
              </ErrorBoundary>
            </ThemeProvider>
          </RegistryProvider>
        </KeymapProvider>,
      );
    });
  });

const dyad = Command.make(
  "dyad",
  {
    controller: Flag.Boolean("controller").pipe(
      Flag.withDescription("Control the session from this device, without audio"),
      Flag.withDefault(false),
    ),
  },
  ({ controller }) => Effect.scoped(player(controller)).pipe(reportFailures),
).pipe(
  Command.withDescription("Play the library of a Dyad server"),
  Command.withSubcommands([...authCommands, ...accountCommands, ...pluginCommands]),
);

Command.run(dyad, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
