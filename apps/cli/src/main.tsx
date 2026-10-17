import { RegistryProvider } from "@effect/atom-react";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createCliRenderer, setupAudio } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Data, Effect, FileSystem, Path } from "effect";
import { Command } from "effect/cli";

import { accountCommands } from "./accounts.ts";
import { App } from "./app.tsx";
import { authCommands, deviceToken, reportFailures, serverUrl as serverUrlConfig } from "./auth.ts";
import { loadSession, saveSession } from "./session.ts";
import type { SavedSession } from "./session.ts";
import { serverAtoms } from "./state.ts";

class RendererError extends Data.TaggedError("RendererError")<{ readonly cause: unknown }> {}

const player = Effect.gen(function* () {
  const serverUrl = yield* serverUrlConfig;
  const atoms = serverAtoms(serverUrl, yield* deviceToken);
  const saved = yield* loadSession(serverUrl);
  const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>();
  // A failed save must not stop the player; the next change saves again
  const save = (session: SavedSession) =>
    saveSession(serverUrl, session).pipe(Effect.provideContext(services), Effect.ignore);
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

  yield* Effect.callback<void>((resume) => {
    renderer.once("destroy", () => resume(Effect.void));
    createRoot(renderer).render(
      <RegistryProvider>
        <App serverUrl={serverUrl} atoms={atoms} audio={audio} saved={saved} save={save} />
      </RegistryProvider>,
    );
  });
});

const dyad = Command.make("dyad", {}, () => Effect.scoped(player).pipe(reportFailures)).pipe(
  Command.withDescription("Play the library of a Dyad server"),
  Command.withSubcommands([...authCommands, ...accountCommands]),
);

Command.run(dyad, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
