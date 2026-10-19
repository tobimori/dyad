import { titleOf } from "@dyad/client-runtime";
import type { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary, WebLink } from "@dyad/domain";
import { NodeServices } from "@effect/platform-node";
import { Data, Effect, Fiber } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { useEffect, useState } from "react";

import { SongItem } from "../context/action-items.ts";
import type { ActionApp, ActionItem } from "../context/action-items.ts";
import { commands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";

const dialogWidth = 64;

const opener = (url: string) => {
  if (process.platform === "darwin") return ChildProcess.make("open", [url]);
  if (process.platform === "win32") return ChildProcess.make("cmd", ["/c", "start", "", url]);
  return ChildProcess.make("xdg-open", [url]);
};

class OpenFailed extends Data.TaggedError("OpenFailed")<{}> {}

/** Fails when the system has no opener, for example over SSH */
const openUrl = Effect.fn(
  function* (url: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const code = yield* spawner.exitCode(opener(url));
    if (code !== 0) return yield* new OpenFailed();
  },
  (effect) => effect.pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

function WebLinksDialog(props: {
  readonly connection: typeof ServerConnection.Service;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly source: SourceSummary;
}) {
  const theme = useTheme();
  const dialog = useDialog();
  const toast = useToast();
  const [links, setLinks] = useState<ReadonlyArray<WebLink> | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const fiber = props.run(
      props.connection
        .webLinks({ sourceId: props.source.id })
        .pipe(Effect.match({ onSuccess: setLinks, onFailure: () => setFailed(true) })),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  const options = (links ?? []).map(
    (link) =>
      new SelectOption({
        value: link.url,
        title: `Open on ${link.providerName}`,
        detail: URL.parse(link.url)?.host ?? "",
      }),
  );

  const empty = () => {
    if (failed) return "Cannot load the links. Try again.";
    return links === null ? "Loading…" : "No provider gives a web page for this song";
  };

  const open = (url: string) => {
    dialog.pop();
    props.run(
      openUrl(url).pipe(
        Effect.match({
          onSuccess: () => toast("notice", `Opened ${URL.parse(url)?.host ?? url}`),
          onFailure: () => toast("error", `Cannot open a browser. The page is ${url}`),
        }),
      ),
    );
  };

  return (
    <Dialog title={titleOf(props.source)} width={dialogWidth}>
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={8}
        empty={empty()}
        onChoose={open}
      />
      {options.length > 0 && <text fg={theme.faint}>⏎ open in the browser · esc close</text>}
    </Dialog>
  );
}

/** The pages of the song on the sites of the providers that have it */
export function useWebLinks(props: {
  readonly connection: typeof ServerConnection.Service | null;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const dialog = useDialog();
  const toast = useToast();

  return (source: SourceSummary) => {
    const connection = props.connection;
    return new Action({
      command: commands.openOnWeb,
      label: "Open on the web…",
      run: () =>
        connection === null
          ? toast("error", "Connect to the server to find the web pages")
          : dialog.push(<WebLinksDialog connection={connection} run={props.run} source={source} />),
    });
  };
}

export function useWebLinkActions(app: ActionApp) {
  const webLinks = useWebLinks({ connection: app.client, run: app.run });
  return (item: ActionItem) => (item instanceof SongItem ? [webLinks(item.source)] : []);
}
