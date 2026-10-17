import { RegistryProvider } from "@effect/atom-react";
import { NodeRuntime } from "@effect/platform-node";
import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { Config, Data, Effect } from "effect";

import { App } from "./app.tsx";
import { serverDescriptor } from "./state.ts";

class RendererError extends Data.TaggedError("RendererError")<{ readonly cause: unknown }> {}

const program = Effect.gen(function* () {
  const serverUrl = yield* Config.String("DYAD_SERVER_URL").pipe(
    Config.withDefault("http://127.0.0.1:4310"),
  );
  const server = serverDescriptor(serverUrl);

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
        <App serverUrl={serverUrl} server={server} />
      </RegistryProvider>,
    );
  });
});

program.pipe(Effect.scoped, NodeRuntime.runMain);
