import { Data } from "effect";
import type { ReactNode } from "react";

import type { Command } from "./keymap.ts";
import type { ScreenApp } from "./screen-app.ts";

/** A section's data on each render, for the sidebar, the reload and its screen */
export class SectionView extends Data.Class<{
  /** The sidebar shows it */
  readonly count: number;
  readonly render: () => ReactNode;
  /** Runs when a key or a click opens the section, but not on `tab` */
  readonly focus?: () => void;
}> {}

/** One entry of the sidebar. The built-ins register in `routes/sections.ts`. */
export class Section extends Data.Class<{
  readonly id: string;
  readonly title: string;
  readonly order: number;
  /** The key that opens the section from anywhere */
  readonly command: Command | null;
  /** A hook. The shell calls it for each section on each render, for the counts in the sidebar. */
  readonly useView: (app: ScreenApp) => SectionView;
}> {}
