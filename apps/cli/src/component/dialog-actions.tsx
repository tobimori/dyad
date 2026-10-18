import { Data } from "effect";

import type { Command } from "../context/keymap.ts";
import { keyLabel } from "../context/keymap.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";

/** A command with a label that can name its target, for example the artist */
export class Action extends Data.Class<{
  readonly command: Command;
  readonly label: string;
  readonly run: () => void;
}> {}

const actionsWidth = 56;

export function ActionsDialog(props: {
  readonly title: string;
  readonly actions: ReadonlyArray<Action>;
}) {
  const dialog = useDialog();
  // A track in a DJ set and the set can both have an action with the same command
  const options = props.actions.map(
    (action, index) =>
      new SelectOption({
        value: index,
        title: action.label,
        detail: action.command.keys[0] === undefined ? "" : keyLabel(action.command.keys[0]),
      }),
  );

  const run = (index: number) => {
    dialog.pop();
    props.actions[index]?.run();
  };

  return (
    <Dialog title={props.title} width={actionsWidth}>
      <SelectList options={options} width={actionsWidth - 4} rows={12} onChoose={run} />
    </Dialog>
  );
}
