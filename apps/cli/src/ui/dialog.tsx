import type { BoxRenderable, Renderable } from "@opentui/core";
import { useRenderer, useTerminalDimensions } from "@opentui/react";
import { Data } from "effect";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

import { commands, useCommands } from "../context/keymap.ts";
import { useTheme } from "../theme/theme.ts";

class OpenDialog extends Data.Class<{
  readonly id: number;
  readonly element: ReactNode;
  readonly restoreFocus: Renderable | null;
}> {}

class DialogStack extends Data.Class<{
  readonly push: (element: ReactNode) => void;
  /** Focus goes back where it was before the replaced dialog */
  readonly replace: (element: ReactNode) => void;
  readonly pop: () => void;
  readonly clear: () => void;
}> {}

const noDialogs = new DialogStack({
  push: () => {},
  replace: () => {},
  pop: () => {},
  clear: () => {},
});

const DialogContext = createContext(noDialogs);

export const useDialog = () => useContext(DialogContext);

const isWithin = (renderable: Renderable | null, ancestor: Renderable) => {
  if (renderable === null) return false;
  if (renderable === ancestor) return true;
  return isWithin(renderable.parent, ancestor);
};

/** A dialog takes the focus, so that only its keys work, and gives it back when it closes */
export function DialogProvider(props: { readonly children: ReactNode }) {
  const renderer = useRenderer();
  const theme = useTheme();
  const [stack, setStack] = useState<ReadonlyArray<OpenDialog>>([]);
  // Handlers of one key press can close more than one dialog before the next render
  const stackRef = useRef(stack);
  const lastId = useRef(0);

  const update = (next: ReadonlyArray<OpenDialog>) => {
    stackRef.current = next;
    setStack(next);
  };

  const restore = (target: Renderable | null) => {
    if (target !== null && !target.isDestroyed) target.focus();
  };

  const open = (element: ReactNode, restoreFocus: Renderable | null) => {
    lastId.current += 1;
    return new OpenDialog({ id: lastId.current, element, restoreFocus });
  };

  const dialogs = new DialogStack({
    push: (element) =>
      update([...stackRef.current, open(element, renderer.currentFocusedRenderable)]),
    replace: (element) => {
      const top = stackRef.current.at(-1);
      const restoreFocus = top === undefined ? renderer.currentFocusedRenderable : top.restoreFocus;
      update([...stackRef.current.slice(0, -1), open(element, restoreFocus)]);
    },
    pop: () => {
      const top = stackRef.current.at(-1);
      if (top === undefined) return;
      update(stackRef.current.slice(0, -1));
      restore(top.restoreFocus);
    },
    clear: () => {
      const bottom = stackRef.current[0];
      if (bottom === undefined) return;
      update([]);
      restore(bottom.restoreFocus);
    },
  });

  return (
    <DialogContext value={dialogs}>
      {props.children}
      {stack.map((dialog) => (
        <box
          key={dialog.id}
          position="absolute"
          zIndex={20}
          top={0}
          left={0}
          width="100%"
          height="100%"
          justifyContent="center"
          alignItems="center"
          backgroundColor={theme.backdrop}
          onMouseDown={function (event) {
            if (event.target === this) dialogs.pop();
          }}
        >
          {dialog.element}
        </box>
      ))}
    </DialogContext>
  );
}

/** `escape` closes the dialog */
export function Dialog(props: {
  readonly title: string;
  readonly width: number;
  readonly children: ReactNode;
}) {
  const renderer = useRenderer();
  const screen = useTerminalDimensions();
  const theme = useTheme();
  const dialog = useDialog();
  const frame = useRef<BoxRenderable | null>(null);

  useCommands([[commands.close, dialog.pop]], { target: frame, targetMode: "focus-within" });

  // A control in the dialog, for example a filter field, can take the focus first
  useEffect(() => {
    const box = frame.current;
    if (box !== null && !isWithin(renderer.currentFocusedRenderable, box)) box.focus();
  }, []);

  return (
    <box
      ref={frame}
      focusable
      width={Math.min(props.width, screen.width - 4)}
      maxHeight={screen.height - 2}
      flexDirection="column"
      border
      borderStyle="rounded"
      borderColor={theme.accent}
      focusedBorderColor={theme.accent}
      backgroundColor={theme.panel}
      title={` ${props.title} `}
      titleColor={theme.text}
      paddingX={1}
    >
      {props.children}
    </box>
  );
}
