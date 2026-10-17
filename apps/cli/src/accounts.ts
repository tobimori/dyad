import { ServerConnection } from "@dyad/client-runtime";
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { deviceConnection, fail, reportFailures } from "./auth.ts";
import { browserLogin } from "./browser-login.ts";

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
  { provider: Argument.String("provider") },
  ({ provider }) =>
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      const providers = yield* connection.listAccountProviders();
      const accountProvider = providers.find((candidate) => candidate.provider === provider);
      if (accountProvider === undefined) {
        return yield* fail(
          `Unknown provider. Use one of: ${providers.map((p) => p.provider).join(", ")}`,
        );
      }

      yield* Console.log(`Sign in to ${accountProvider.name} in the browser window`);
      const credentials = yield* browserLogin(accountProvider.login);
      const account = yield* connection.linkAccount({ provider, credentials });
      yield* Console.log(`Linked ${account.displayName}`);
    }).pipe(Effect.provide(deviceConnection), reportFailures),
).pipe(Command.withDescription("Sign in to a provider and link the account"));

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
