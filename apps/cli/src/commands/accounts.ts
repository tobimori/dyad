import { ServerConnection } from "@dyad/client-runtime";
import { Console, Effect, Option } from "effect";
import { Argument, Command, Flag, Prompt } from "effect/cli";

import { deviceConnection, fail, reportFailures } from "./auth.ts";
import { availableCookieBrowsers, readBrowserCookies } from "./browser-cookies.ts";
import { readCookieFile } from "./cookie-import.ts";

const accountsCommand = Command.make("accounts", {}, () =>
  Effect.gen(function* () {
    const connection = yield* ServerConnection;
    const providers = yield* connection.listAccountProviders();
    const accounts = yield* connection.listAccounts();

    for (const provider of providers) {
      const account = accounts.find((account) => account.provider === provider.provider);
      const state = account === undefined ? "not linked" : account.displayName;
      yield* Console.log(`${provider.provider}  ${provider.name}: ${state}`);
    }
  }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("List the provider accounts that you can link"));

const linkCommand = Command.make(
  "link",
  {
    provider: Argument.String("provider"),
    cookies: Flag.String("cookies").pipe(
      Flag.withDescription("Import a Netscape cookies.txt file"),
      Flag.optional,
    ),
  },
  ({ provider, cookies }) =>
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      const providers = yield* connection.listAccountProviders();
      const accountProvider = providers.find((candidate) => candidate.provider === provider);
      if (accountProvider === undefined) {
        return yield* fail(
          `Unknown provider. Use one of: ${providers.map((p) => p.provider).join(", ")}`,
        );
      }

      const credentials = yield* Effect.gen(function* () {
        if (Option.isSome(cookies))
          return yield* readCookieFile(accountProvider.login, cookies.value);
        const browsers = yield* availableCookieBrowsers;
        const index = yield* Prompt.Select({
          message: "Import cookies",
          choices: [
            { title: "Import cookie file", value: -1 },
            ...browsers.map((browser, value) => ({ title: `Import from ${browser.name}`, value })),
          ],
        });
        const browser = browsers[index];
        if (browser === undefined) {
          yield* Console.log(
            "Sign in in a private window, export cookies.txt, then close the window.",
          );
          const file = yield* Prompt.String({ message: "Cookie file" });
          return yield* readCookieFile(accountProvider.login, file);
        }
        yield* Console.log(
          `Normal browser cookies expire sooner than a private-window export. Re-import when Dyad says "Sign in to ${accountProvider.name} again".`,
        );
        const profile =
          browser.profiles.length === 1
            ? browser.profiles[0]!
            : yield* Prompt.Select({
                message: "Choose the signed-in profile",
                choices: browser.profiles.map((profile) => ({
                  title: profile.name,
                  value: profile,
                })),
              });
        return yield* readBrowserCookies(browser, profile, accountProvider.login);
      });
      const account = yield* connection.linkAccount({ provider, credentials });
      yield* Console.log(`Linked ${account.displayName}`);
    }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Import browser cookies and link a provider account"));

const unlinkCommand = Command.make(
  "unlink",
  { provider: Argument.String("provider") },
  ({ provider }) =>
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      yield* connection.unlinkAccount({ provider });
      yield* Console.log("Unlinked. The server deleted the stored credentials.");
    }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Unlink a provider account"));

export const accountCommands = [accountsCommand, linkCommand, unlinkCommand] as const;
