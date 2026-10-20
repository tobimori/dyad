import { audioLabel, formatDuration, titleOf } from "@dyad/client-runtime";
import type { SourceCopies, SourceCopy, SourceSummary } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import type { BoxRenderable } from "@opentui/core";
import { Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { SongItem } from "../context/action-items.ts";
import type { ActionApp, ActionItem } from "../context/action-items.ts";
import { commands, useCommands } from "../context/keymap.ts";
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
  readonly app: ActionApp;
  readonly source: SourceSummary;
  readonly onPlay: (source: SourceSummary) => void;
}) {
  const dialog = useDialog();
  const toast = useToast();
  const theme = useTheme();
  const content = useRef<BoxRenderable | null>(null);
  const [highlighted, setHighlighted] = useState(0);
  const result: AsyncResult.AsyncResult<SourceCopies, unknown> = useAtomValue(
    props.app.atoms.sourceCopies(props.source.id),
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

  // The matcher never puts the two songs together again
  const separate = () => {
    const copy = copies[highlighted];
    const own = props.source.recordingId;
    if (copy === undefined || copy.source.recordingId === null || own === null) return;
    if (copy.source.id === props.source.id) {
      toast("notice", "This is the copy that you chose");
      return;
    }
    props.app.run(
      props.app.replica.unmergeRecording({ fromId: copy.source.recordingId, intoId: own }).pipe(
        Effect.match({
          onSuccess: () => {
            toast("notice", `${copyName(copy)} is no longer a copy of this song`);
            dialog.pop();
          },
          onFailure: () => toast("error", "Cannot separate the songs"),
        }),
      ),
    );
  };
  useCommands([[commands.notSameSong, separate]], { target: content, targetMode: "focus-within" });

  return (
    <Dialog title={`Play from · ${titleOf(props.source)}`} width={dialogWidth}>
      <box ref={content} flexDirection="column">
        <SelectList
          options={options}
          width={dialogWidth - 4}
          rows={10}
          empty={empty()}
          onChoose={choose}
          onHighlight={setHighlighted}
        />
      </box>
      {searching && copies.length > 0 ? (
        <text fg={theme.muted}>Searching all providers…</text>
      ) : null}
    </Dialog>
  );
}

/** All copies of the song on all providers and as files, with their quality and access */
export function usePlayFrom(app: ActionApp) {
  const dialog = useDialog();
  return (source: SourceSummary, play: (copy: SourceSummary) => void) =>
    new Action({
      command: commands.playFrom,
      label: "Play from…",
      run: () => dialog.push(<PlayFromDialog app={app} source={source} onPlay={play} />),
    });
}

// A new play: switching the source of an entry in place belongs to the session
export function usePlayFromActions(app: ActionApp) {
  const playFrom = usePlayFrom(app);
  return (item: ActionItem) =>
    item instanceof SongItem
      ? [playFrom(item.source, (copy) => app.player.playCopy(copy, item.context))]
      : [];
}
