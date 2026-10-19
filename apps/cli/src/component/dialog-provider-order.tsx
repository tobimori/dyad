import type { ServerAtoms } from "@dyad/client-runtime";
import type { BoxRenderable } from "@opentui/core";
import { useAtomValue } from "@effect/atom-react";
import { Option } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { commands, useCommands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";

const dialogWidth = 56;

/**
 * The order of the providers that chooses which copy of a song plays. It syncs to the user's other
 * devices and applies offline at once.
 */
export function ProviderOrderDialog(props: {
  readonly atoms: ServerAtoms;
  /** `[]` gives the default order */
  readonly setOrder: (providers: ReadonlyArray<string>) => void;
}) {
  const theme = useTheme();
  const dialog = useDialog();
  const content = useRef<BoxRenderable | null>(null);
  const result = useAtomValue(props.atoms.providerChoices);
  const choices = Option.getOrNull(AsyncResult.value(result));
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [generation, setGeneration] = useState(0);

  const providers = choices?.providers ?? [];
  const options = providers.map(
    (choice, index) =>
      new SelectOption({
        value: choice.provider,
        title: `${index + 1}  ${choice.name}`,
        detail: "",
      }),
  );

  const move = (direction: 1 | -1) => {
    const order = providers.map((choice) => choice.provider);
    const index = order.findIndex((provider) => provider === highlighted);
    const target = index + direction;
    if (index === -1 || target < 0 || target >= order.length) return;
    const moved = order.toSpliced(index, 1).toSpliced(target, 0, order[index] ?? "");
    props.setOrder(moved);
    // The list starts again with the moved provider highlighted
    setGeneration((value) => value + 1);
  };

  useCommands(
    [
      [commands.orderUp, () => move(-1)],
      [commands.orderDown, () => move(1)],
      [
        commands.orderReset,
        () => {
          props.setOrder([]);
          setGeneration((value) => value + 1);
        },
      ],
    ],
    { target: content, targetMode: "focus-within" },
  );

  return (
    <Dialog title="Provider order" width={dialogWidth}>
      <text fg={theme.muted}>The first provider that has a song plays it.</text>
      <box ref={content} flexDirection="column">
        <SelectList
          key={generation}
          {...(highlighted === null ? {} : { initial: highlighted })}
          options={options}
          width={dialogWidth - 4}
          rows={10}
          empty={AsyncResult.isInitial(result) ? "Loading…" : "No provider is known yet"}
          // Each move applies at once, so Enter only closes
          onChoose={() => dialog.pop()}
          onHighlight={(provider: string) => setHighlighted(provider)}
        />
      </box>
      <text fg={theme.faint}>
        {choices?.custom === true
          ? "Your order. d restores the default."
          : "Default: local files, then lossless copies"}
      </text>
    </Dialog>
  );
}
