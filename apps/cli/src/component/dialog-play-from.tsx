import { audioLabel, formatDuration, titleOf } from "@dyad/client-runtime";
import type { ServerAtoms } from "@dyad/client-runtime";
import type { SourceCopies, SourceCopy, SourceSummary } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";

import { commands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";

const dialogWidth = 84;

const copyName = (copy: SourceCopy) =>
  copy.source.provider === "local"
    ? "Local file"
    : (copy.source.providerName ?? copy.source.provider);

const accessOf = (copy: SourceCopy) => {
  if (copy.unavailable === "account_required") return `link ${copyName(copy)}`;
  return copy.unavailable === "unavailable" ? "not on this server" : null;
};

// Quality and length decide between copies; access only when the user cannot play the copy
const copyDetail = (copy: SourceCopy, current: string) =>
  [
    audioLabel({ ...copy, codec: copy.source.codec }),
    formatDuration(copy.source.durationMs),
    copy.source.id === current ? "current" : null,
    accessOf(copy),
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");

function PlayFromDialog(props: {
  readonly atoms: ServerAtoms;
  readonly source: SourceSummary;
  readonly onPlay: (source: SourceSummary) => void;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const theme = useTheme();
  const result: AsyncResult.AsyncResult<SourceCopies, unknown> = useAtomValue(
    props.atoms.sourceCopies(props.source.id),
  );
  const copies = AsyncResult.isSuccess(result) ? result.value.copies : [];
  const searching = AsyncResult.isSuccess(result) && result.value.searching;

  const options = copies.map(
    (copy, index) =>
      new SelectOption({
        value: index,
        // The edition tells a session from a single, for example
        title: [copyName(copy), copy.source.album].filter((part) => part !== null).join(" · "),
        detail: copyDetail(copy, props.source.id),
      }),
  );

  const empty = () => {
    if (AsyncResult.isFailure(result)) return "Cannot load the copies. Try again.";
    if (AsyncResult.isInitial(result)) return "Loading…";
    return searching ? "Searching all providers…" : "No other copy of this song is known";
  };

  const choose = (index: number) => {
    const copy = copies[index];
    if (copy === undefined) return;
    if (copy.unavailable === "account_required") {
      toast("notice", `Link ${copyName(copy)} to play this copy`);
      return;
    }
    if (copy.unavailable !== null) {
      toast("notice", "This server has no access to this copy");
      return;
    }
    dialog.pop();
    props.onPlay(copy.source);
  };

  return (
    <Dialog title={`Play from · ${titleOf(props.source)}`} width={dialogWidth}>
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={10}
        empty={empty()}
        onChoose={choose}
      />
      {searching && copies.length > 0 ? (
        <text fg={theme.muted}>Searching all providers…</text>
      ) : null}
    </Dialog>
  );
}

/** All copies of the song on all providers and as files, with their quality and access */
export function usePlayFrom(atoms: ServerAtoms) {
  const dialog = useDialog();
  return (source: SourceSummary, play: (copy: SourceSummary) => void) =>
    new Action({
      command: commands.playFrom,
      label: "Play from…",
      run: () => dialog.push(<PlayFromDialog atoms={atoms} source={source} onPlay={play} />),
    });
}
