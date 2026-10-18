import type { ServerConnection } from "@dyad/client-runtime";
import { AccountLinkFailed } from "@dyad/domain";
import type { AccountProviderSummary, BrowserLogin, ProviderAccountSummary } from "@dyad/domain";
import { NodeServices } from "@effect/platform-node";
import type { InputRenderable } from "@opentui/core";
import { Effect, Fiber, Schema } from "effect";
import { useEffect, useRef, useState } from "react";

import { availableCookieBrowsers, readBrowserCookies } from "../commands/browser-cookies.ts";
import type { CookieBrowser, CookieProfile } from "../commands/browser-cookies.ts";
import { CookieImportError, cookieFileHint, readCookieFile } from "../commands/cookie-import.ts";
import { commands, useCommands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";

const accountsWidth = 56;

const failureText = (error: { readonly _tag: string }) =>
  Schema.is(AccountLinkFailed)(error) || error instanceof CookieImportError
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
  const [browsers, setBrowsers] = useState<ReadonlyArray<CookieBrowser>>([]);
  const linked = props.account !== undefined;

  useEffect(() => {
    const fiber = props.run(
      availableCookieBrowsers.pipe(
        Effect.provide(NodeServices.layer),
        Effect.match({
          onSuccess: setBrowsers,
          onFailure: () => setError("Cannot find browser profiles"),
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  const options = [
    new SelectOption({ value: "file", title: "Import cookie file", detail: "" }),
    ...browsers.map(
      (browser) =>
        new SelectOption({ value: browser.name, title: `Import from ${browser.name}`, detail: "" }),
    ),
    ...(linked ? [new SelectOption({ value: "unlink", title: "Unlink", detail: "" })] : []),
  ];

  const onLinked = (account: ProviderAccountSummary) => {
    toast("notice", `Linked ${account.displayName}`);
    props.onChange();
    dialog.pop();
  };

  const choose = (value: string) => {
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

    if (value === "file") {
      dialog.replace(
        <CookieFileDialog
          login={props.provider.login}
          onSubmit={(file) =>
            dialog.replace(
              <CookieLoginDialog
                {...props}
                read={readCookieFile(props.provider.login, file)}
                onLinked={onLinked}
              />,
            )
          }
        />,
      );
      return;
    }
    const browser = browsers.find((browser) => browser.name === value);
    if (browser === undefined) return;
    const importProfile = (profile: CookieProfile) =>
      dialog.replace(
        <CookieLoginDialog
          {...props}
          read={readBrowserCookies(browser, profile, props.provider.login)}
          onLinked={onLinked}
        />,
      );
    if (browser.profiles.length === 1) {
      importProfile(browser.profiles[0]!);
      return;
    }
    dialog.replace(
      <Dialog title={`${browser.name}: choose the signed-in profile`} width={accountsWidth}>
        <SelectList
          options={browser.profiles.map(
            (profile) => new SelectOption({ value: profile, title: profile.name, detail: "" }),
          )}
          width={accountsWidth - 4}
          rows={8}
          onChoose={importProfile}
        />
      </Dialog>,
    );
  };

  return (
    <Dialog title={props.provider.name} width={accountsWidth}>
      <text fg={theme.muted}>
        {props.account === undefined ? "Not linked" : `Linked as ${props.account.displayName}`}
      </text>
      <box marginTop={1}>
        <SelectList options={options} width={accountsWidth - 4} rows={8} onChoose={choose} />
      </box>
      <text fg={theme.muted}>{cookieFileHint(props.provider.login)}</text>
      <text fg={theme.muted}>
        {`Normal browser cookies expire sooner than a private-window export. Re-import when Dyad says "Sign in to ${props.provider.name} again".`}
      </text>
      {error !== null && <text fg={theme.error}>{error}</text>}
    </Dialog>
  );
}

function CookieFileDialog(props: {
  readonly login: BrowserLogin;
  readonly onSubmit: (file: string) => void;
}) {
  const theme = useTheme();
  const input = useRef<InputRenderable | null>(null);
  const [file, setFile] = useState("");
  useCommands(
    [
      [
        commands.submitInput,
        () => {
          if (file.trim() !== "") props.onSubmit(file.trim());
        },
      ],
    ],
    { target: input, targetMode: "focus" },
  );
  useEffect(() => {
    input.current?.focus();
  }, []);
  return (
    <Dialog title="Import cookie file" width={accountsWidth}>
      <text fg={theme.muted}>{cookieFileHint(props.login)}</text>
      <input
        ref={input}
        value={file}
        placeholder="Path to cookies.txt"
        onInput={setFile}
        backgroundColor={theme.panel}
        focusedBackgroundColor={theme.panel}
        textColor={theme.text}
        focusedTextColor={theme.text}
        placeholderColor={theme.faint}
        cursorColor={theme.accent}
      />
      <text fg={theme.faint}>⏎ import · esc cancel</text>
    </Dialog>
  );
}

function CookieLoginDialog(props: {
  readonly provider: AccountProviderSummary;
  readonly connection: typeof ServerConnection.Service;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly onLinked: (account: ProviderAccountSummary) => void;
  readonly read: ReturnType<typeof readBrowserCookies>;
}) {
  const theme = useTheme();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fiber = props.run(
      props.read.pipe(
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
        {error ?? "Importing cookies. Allow the browser key in Keychain if asked."}
      </text>
    </Dialog>
  );
}
