// OpenTUI 0.6.6 resolves its native library in a top-level await, so this import must be first
import "./sea-assets.ts";

import { serverAtoms } from "@dyad/client-runtime";
import type { SavedSession } from "@dyad/client-runtime";
import { ClientPluginContext } from "@dyad/plugin/client";
import type { NowPlaying } from "@dyad/plugin/client";
import { RegistryProvider } from "@effect/atom-react";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createCliRenderer, setupAudio } from "@opentui/core";
import { KeymapProvider } from "@opentui/keymap/react";
import { createRoot } from "@opentui/react";
import { Cause, Data, Effect, FileSystem, Layer, Option, Path, SubscriptionRef } from "effect";
import { Command } from "effect/cli";

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
import { loadSession, saveSession } from "./context/session.ts";
import { ThemeProvider } from "./context/theme-provider.tsx";
import { fileLogging, processErrorLogging } from "./log.ts";
import { DialogProvider } from "./ui/dialog.tsx";
import { ErrorBoundary } from "./ui/error-boundary.tsx";
import { ToastProvider } from "./ui/toast.tsx";

class RendererError extends Data.TaggedError("RendererError")<{ readonly cause: unknown }> {}

const player = Effect.gen(function* () {
  const logging = yield* fileLogging;
  const logServices = yield* Layer.build(logging);
  const run = Effect.runForkWith(logServices);
  yield* processErrorLogging(logServices);

  const serverUrl = yield* serverUrlConfig;
  const atoms = serverAtoms(serverUrl, yield* deviceToken, logging);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  // The app can start again after an error, and then it restores the newest session
  const latest = { session: yield* loadSession(serverUrl) };
  const save = (session: SavedSession) =>
    Effect.sync(() => {
      latest.session = Option.some(session);
    }).pipe(
      Effect.andThen(saveSession(serverUrl, session)),
      Effect.provideContext(services),
      // A failed save must not stop the player; the next change saves again
      Effect.tapCause((cause) => Effect.logWarning("Cannot save the session", cause)),
      Effect.provideContext(logServices),
      Effect.ignore,
    );

  const nowPlaying = yield* SubscriptionRef.make<NowPlaying | null>(null);
  const plugins = yield* startPluginHost(
    new ClientPluginContext({
      serverOrigin: serverUrl,
      playback: { nowPlaying: SubscriptionRef.changes(nowPlaying) },
    }),
  ).pipe(Effect.provideContext(logServices));

  const audio = yield* Effect.acquireRelease(
    Effect.sync(() => setupAudio()),
    (audio) => Effect.sync(() => audio.dispose()),
  );

  // The Effect runtime owns process signals. The app handles Ctrl+C as a key, so that it can
  // report the current play before it quits.
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
                    audio={audio}
                    restore={() => latest.session}
                    save={save}
                    run={run}
                    nowPlaying={nowPlaying}
                    plugins={plugins}
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

const dyad = Command.make("dyad", {}, () => Effect.scoped(player).pipe(reportFailures)).pipe(
  Command.withDescription("Play the library of a Dyad server"),
  Command.withSubcommands([...authCommands, ...accountCommands, ...pluginCommands]),
);

Command.run(dyad, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
