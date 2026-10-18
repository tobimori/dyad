import type { ServerConnection } from "@dyad/client-runtime";
import { AccountLinkFailed } from "@dyad/domain";
import type { AccountProviderSummary, ProviderAccountSummary } from "@dyad/domain";
import { NodeServices } from "@effect/platform-node";
import { Effect, Fiber, Schema } from "effect";
import { useEffect, useState } from "react";

import { BrowserLoginError, browserLogin } from "../commands/browser-login.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";

const accountsWidth = 56;

const failureText = (error: { readonly _tag: string }) =>
  Schema.is(AccountLinkFailed)(error) || error instanceof BrowserLoginError
    ? error.reason
    : "The server did not answer. Try again.";

/** The providers with an account, and the account of each that the user linked */
export function AccountsDialog(props: {
  readonly connection: typeof ServerConnection.Service;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const theme = useTheme();
  const dialog = useDialog();
  const [providers, setProviders] = useState<ReadonlyArray<AccountProviderSummary> | null>(null);
  const [accounts, setAccounts] = useState<ReadonlyArray<ProviderAccountSummary>>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    props.run(
      Effect.all([props.connection.listAccountProviders(), props.connection.listAccounts()]).pipe(
        Effect.match({
          onSuccess: ([nextProviders, nextAccounts]) => {
            setProviders(nextProviders);
            setAccounts(nextAccounts);
            setError(null);
          },
          onFailure: (failure) => setError(failureText(failure)),
        }),
      ),
    );

  useEffect(() => {
    load();
  }, []);

  const accountOf = (provider: AccountProviderSummary) =>
    accounts.find((account) => account.provider === provider.provider);

  // The provider ID keeps the highlight when the list loads again
  const options = (providers ?? []).map(
    (provider) =>
      new SelectOption({
        value: provider.provider,
        title: provider.name,
        detail: accountOf(provider)?.displayName ?? "not linked",
      }),
  );

  const choose = (id: string) => {
    const provider = providers?.find((candidate) => candidate.provider === id);
    if (provider === undefined) return;
    dialog.push(
      <AccountDialog
        provider={provider}
        account={accountOf(provider)}
        connection={props.connection}
        run={props.run}
        onChange={load}
      />,
    );
  };

  return (
    <Dialog title="Provider accounts" width={accountsWidth}>
      <SelectList
        options={options}
        width={accountsWidth - 4}
        rows={12}
        empty={providers === null ? "Loading…" : "No provider has accounts"}
        onChoose={choose}
      />
      {error !== null && <text fg={theme.error}>{error}</text>}
    </Dialog>
  );
}

type AccountAction = "browser" | "unlink";

function AccountDialog(props: {
  readonly provider: AccountProviderSummary;
  readonly account: ProviderAccountSummary | undefined;
  readonly connection: typeof ServerConnection.Service;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  /** Called after a link or an unlink */
  readonly onChange: () => void;
}) {
  const theme = useTheme();
  const dialog = useDialog();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const linked = props.account !== undefined;

  const action = (value: AccountAction, title: string) =>
    new SelectOption({ value, title, detail: "" });
  const options = [
    action("browser", linked ? "Sign in again" : "Sign in"),
    ...(linked ? [action("unlink", "Unlink")] : []),
  ];

  const onLinked = (account: ProviderAccountSummary) => {
    toast("notice", `Linked ${account.displayName}`);
    props.onChange();
    dialog.pop();
  };

  const choose = (value: AccountAction) => {
    if (value === "unlink") {
      props.run(
        props.connection.unlinkAccount({ provider: props.provider.provider }).pipe(
          Effect.match({
            onSuccess: () => {
              toast("notice", `Unlinked ${props.provider.name}`);
              props.onChange();
              dialog.pop();
            },
            onFailure: (failure) => setError(failureText(failure)),
          }),
        ),
      );
      return;
    }

    dialog.replace(<BrowserLoginDialog {...props} onLinked={onLinked} />);
  };

  return (
    <Dialog title={props.provider.name} width={accountsWidth}>
      <text fg={theme.muted}>
        {props.account === undefined ? "Not linked" : `Linked as ${props.account.displayName}`}
      </text>
      <box marginTop={1}>
        <SelectList options={options} width={accountsWidth - 4} rows={4} onChoose={choose} />
      </box>
      {error !== null && <text fg={theme.error}>{error}</text>}
    </Dialog>
  );
}

function BrowserLoginDialog(props: {
  readonly provider: AccountProviderSummary;
  readonly connection: typeof ServerConnection.Service;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly onLinked: (account: ProviderAccountSummary) => void;
}) {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);

  // Closing the dialog stops the sign-in and closes the browser
  useEffect(() => {
    const fiber = props.run(
      browserLogin(props.provider.login).pipe(
        Effect.provide(NodeServices.layer),
        Effect.flatMap((credentials) =>
          props.connection.linkAccount({ provider: props.provider.provider, credentials }),
        ),
        Effect.match({
          onSuccess: props.onLinked,
          onFailure: (failure) => setError(failureText(failure)),
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  return (
    <Dialog title={props.provider.name} width={accountsWidth}>
      <text fg={error === null ? theme.text : theme.error}>
        {error ??
          `Sign in to ${props.provider.name} in the browser window. Dyad links the account when you are signed in.`}
      </text>
    </Dialog>
  );
}
