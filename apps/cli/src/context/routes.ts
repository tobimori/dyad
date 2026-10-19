import type { ServerAtoms } from "@dyad/client-runtime";
import { Data } from "effect";
import type { ReactNode } from "react";

import type { Action } from "../component/dialog-actions.tsx";
import type { usePlaylistActions } from "../component/dialog-playlists.tsx";
import type { SelectableRow } from "../component/row-list.tsx";
import type { TrackItem } from "../component/track-list.tsx";
import type { usePlayer } from "../playback/use-player.ts";
import type { Command } from "./keymap.ts";
import type { useSearch } from "./use-search.ts";

/** The host renders it only while the section route is on top */
export class SectionView extends Data.Class<{
  /** The rows that the cursor moves over. The sidebar shows their count. */
  readonly items: ReadonlyArray<TrackItem | SelectableRow>;
  readonly render: (list: {
    readonly selected: number;
    readonly select: (index: number) => void;
    readonly activate: (index: number) => void;
    readonly selectRow: (row: SelectableRow) => void;
    readonly activateRow: (row: SelectableRow) => void;
  }) => ReactNode;
  readonly refresh?: () => void;
  /** Plays the track item at `index`. Without it, the list plays from that item. */
  readonly play?: (index: number) => void;
  /** Keys before the common list keys. The handler gets the selected index. */
  readonly keys?: ReadonlyArray<readonly [Command, (selected: number) => void]>;
  /** Actions after the common track actions, for the item at `index` or the current track */
  readonly actions?: (index: number | null) => ReadonlyArray<Action>;
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
  /** A hook. The host calls it for each section on each render, for the counts in the sidebar. */
  readonly useView: (app: {
    readonly atoms: ServerAtoms;
    readonly player: ReturnType<typeof usePlayer>;
    readonly search: ReturnType<typeof useSearch>;
    readonly focusList: () => void;
    readonly playlistActions: ReturnType<typeof usePlaylistActions>;
  }) => SectionView;
}> {}
