import { Data, Effect } from "effect";
import { createContext, useContext, useRef, useState } from "react";
import type { ReactNode } from "react";

import { useTheme } from "../theme/theme.ts";

class Toast extends Data.Class<{
  readonly id: number;
  readonly kind: "notice" | "error";
  readonly message: string;
}> {}

const toastMs = { notice: 3000, error: 6000 };
const toastWidth = 44;

const ToastContext = createContext<(kind: Toast["kind"], message: string) => void>(() => {});

export const useToast = () => useContext(ToastContext);

export function ToastProvider(props: { readonly children: ReactNode }) {
  const theme = useTheme();
  const [toasts, setToasts] = useState<ReadonlyArray<Toast>>([]);
  const lastId = useRef(0);

  const show = (kind: Toast["kind"], message: string) => {
    lastId.current += 1;
    const toast = new Toast({ id: lastId.current, kind, message });
    // The same message again only extends the time of the toast that shows it
    setToasts((current) => [...current.filter((other) => other.message !== message), toast]);

    Effect.runFork(
      Effect.sleep(toastMs[kind]).pipe(
        Effect.andThen(
          Effect.sync(() => setToasts((current) => current.filter((other) => other !== toast))),
        ),
      ),
    );
  };

  return (
    <ToastContext value={show}>
      {props.children}
      {toasts.length > 0 && (
        <box
          position="absolute"
          zIndex={30}
          top={1}
          right={1}
          width={toastWidth}
          flexDirection="column"
          gap={1}
        >
          {toasts.map((toast) => (
            <box
              key={toast.id}
              border={["left"]}
              borderColor={toast.kind === "error" ? theme.error : theme.accent}
              backgroundColor={theme.panel}
              paddingX={1}
              onMouseDown={() => setToasts((current) => current.filter((other) => other !== toast))}
            >
              <text fg={theme.text}>{toast.message}</text>
            </box>
          ))}
        </box>
      )}
    </ToastContext>
  );
}
