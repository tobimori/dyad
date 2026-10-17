import { useRenderer } from "@opentui/react";
import { Effect, Fiber } from "effect";
import { createContext, useContext, useEffect, useState } from "react";
import type { ReactNode } from "react";

import { ThemeContext, terminalScheme, themeFor } from "./theme.ts";
import type { Hsl } from "./theme.ts";

const CoverContext = createContext<(accent: Hsl | null) => void>(() => {});

/** Sets the accent of the cover, which colors the whole player */
export const useCoverAccent = (accent: Hsl | null) => {
  const setCover = useContext(CoverContext);
  useEffect(() => setCover(accent), [accent]);
};

/**
 * The theme from the colors of the terminal and the accent of the cover. The player starts with
 * the light or dark default colors and takes the palette of the terminal when it answers.
 */
export function ThemeProvider(props: {
  readonly mode: "dark" | "light";
  readonly children: ReactNode;
}) {
  const renderer = useRenderer();
  const [scheme, setScheme] = useState(() => terminalScheme(props.mode, null));
  const [cover, setCover] = useState<Hsl | null>(null);

  useEffect(() => {
    // OpenTUI 0.6.6 can query the palette only after the first frame set up the terminal
    const query = Effect.tryPromise(() => renderer.idle()).pipe(
      Effect.andThen(Effect.tryPromise(() => renderer.getPalette({ size: 16, timeout: 1000 }))),
      Effect.tap((colors) => Effect.sync(() => setScheme(terminalScheme(props.mode, colors)))),
      Effect.ignore,
    );
    const fiber = Effect.runFork(query);
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, []);

  return (
    <ThemeContext value={themeFor(scheme, cover)}>
      <CoverContext value={setCover}>{props.children}</CoverContext>
    </ThemeContext>
  );
}
