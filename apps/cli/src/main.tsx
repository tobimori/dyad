import { RegistryProvider } from "@effect/atom-react";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { createCliRenderer, setupAudio } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Console, Data, Effect, Option } from "effect";
import { Command } from "effect/cli";

import { accountCommands } from "./accounts.ts";
import { App } from "./app.tsx";
import { authCommands, notSignedIn, serverUrl as serverUrlConfig } from "./auth.ts";
import { loadDeviceToken } from "./devices.ts";
import { serverAtoms } from "./state.ts";

class RendererError extends Data.TaggedError("RendererError")<{ readonly cause: unknown }> {}

const player = Effect.gen(function* () {
  const serverUrl = yield* serverUrlConfig;
  const deviceToken = yield* loadDeviceToken(serverUrl);
  if (Option.isNone(deviceToken)) {
    return yield* Console.error(notSignedIn);
  }

  const atoms = serverAtoms(serverUrl, deviceToken);
  const audio = yield* Effect.acquireRelease(
    Effect.sync(() => setupAudio()),
    (audio) => Effect.sync(() => audio.dispose()),
  );

  // The Effect runtime owns process signals; the renderer still handles Ctrl+C as a key
  const renderer = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () => createCliRenderer({ exitSignals: [] }),
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
        <App serverUrl={serverUrl} atoms={atoms} audio={audio} />
      </RegistryProvider>,
    );
  });
});

const dyad = Command.make("dyad", {}, () => Effect.scoped(player)).pipe(
  Command.withDescription("Play the library of a Dyad server"),
  Command.withSubcommands([...authCommands, ...accountCommands]),
);

Command.run(dyad, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
