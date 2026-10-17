import type { BrowserLogin } from "@dyad/domain";
import { Config, Data, Effect, FileSystem, Option, Path, Ref, Schedule, Schema } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { Socket } from "effect/socket";

export class BrowserLoginError extends Data.TaggedError("BrowserLoginError")<{
  readonly reason: string;
}> {}

// Chromium-based browsers, because the login reads cookies through the DevTools protocol
const browserNames = [
  "google-chrome-stable",
  "google-chrome",
  "chromium",
  "chromium-browser",
  "microsoft-edge",
  "brave-browser",
];
const macBrowsers = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
];

const findBrowser = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const configured = yield* Config.option(Config.NonEmptyString("DYAD_BROWSER"));
  if (Option.isSome(configured)) return configured.value;

  const directories = (yield* Config.String("PATH").pipe(Config.withDefault(""))).split(":");
  const candidates = [
    ...directories.flatMap((directory) => browserNames.map((name) => path.join(directory, name))),
    ...macBrowsers,
  ];
  for (const candidate of candidates) {
    if (yield* fs.exists(candidate)) return candidate;
  }

  return yield* new BrowserLoginError({
    reason: "No Chrome, Chromium or Edge found. Set DYAD_BROWSER to the browser program.",
  });
});

// Chrome writes the port and path of its DevTools endpoint to this file when it is ready
const devToolsUrl = (profile: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const text = yield* fs.readFileString(path.join(profile, "DevToolsActivePort"));
    const [port, endpoint] = text.split("\n");
    if (port === undefined || endpoint === undefined || endpoint === "") {
      return yield* new BrowserLoginError({ reason: "The browser is not ready" });
    }
    return `ws://127.0.0.1:${port}${endpoint}`;
  }).pipe(Effect.retry({ schedule: Schedule.spaced("200 millis"), times: 150 }));

const CookiesResponse = Schema.fromJsonString(
  Schema.Struct({
    id: Schema.Number,
    result: Schema.Struct({
      cookies: Schema.Array(
        Schema.Struct({ name: Schema.String, value: Schema.String, domain: Schema.String }),
      ),
    }),
  }),
);

const browserClosed = new BrowserLoginError({
  reason: "The browser closed before the sign-in finished",
});

/**
 * Opens the provider's sign-in page in a new browser profile and waits until the user has signed
 * in. The profile is deleted afterwards, so the browser keeps no session.
 */
export const browserLogin = (login: BrowserLogin) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const browser = yield* findBrowser;
      const profile = yield* fs.makeTempDirectoryScoped({ prefix: "dyad-login-" });

      yield* spawner.spawn(
        ChildProcess.make(
          browser,
          [
            `--user-data-dir=${profile}`,
            "--remote-debugging-port=0",
            "--no-first-run",
            "--no-default-browser-check",
            login.url,
          ],
          { stdout: "ignore", stderr: "ignore" },
        ),
      );

      const socket = yield* Socket.makeWebSocket(yield* devToolsUrl(profile));
      const reader = yield* socket.reader;
      const writer = yield* socket.writer;
      const nextId = yield* Ref.make(0);

      const send = (method: string) =>
        Effect.gen(function* () {
          const id = yield* Ref.updateAndGet(nextId, (id) => id + 1);
          yield* writer.write(JSON.stringify({ id, method }));
          return id;
        });

      const readCookies = Effect.gen(function* () {
        const id = yield* send("Storage.getCookies");

        // The browser target sends no events without a subscription, so the next match is ours
        while (true) {
          const messages = yield* reader.pull;
          for (const message of messages) {
            const response = Schema.decodeUnknownOption(CookiesResponse)(message);
            if (Option.isSome(response) && response.value.id === id) {
              return response.value.result.cookies;
            }
          }
        }
      });

      const isWanted = (cookie: { readonly name: string; readonly domain: string }) =>
        login.cookies.includes(cookie.name) &&
        (cookie.domain === login.domain || cookie.domain.endsWith(`.${login.domain}`));

      const cookies = yield* readCookies.pipe(
        Effect.map((cookies) => cookies.filter(isWanted)),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (cookies) => login.cookies.every((name) => cookies.some((c) => c.name === name)),
        }),
        Effect.timeoutOrElse({
          duration: "10 minutes",
          orElse: () =>
            Effect.fail(new BrowserLoginError({ reason: "The sign-in took more than 10 minutes" })),
        }),
        Effect.catchTag("SocketError", () => Effect.fail(browserClosed)),
      );

      yield* send("Browser.close").pipe(Effect.ignore);
      return Object.fromEntries(cookies.map((cookie) => [cookie.name, cookie.value]));
    }),
  ).pipe(
    Effect.catchTag("PlatformError", () =>
      Effect.fail(new BrowserLoginError({ reason: "Cannot start the browser" })),
    ),
    Effect.provide(Socket.layerWebSocketConstructorGlobal),
  );
