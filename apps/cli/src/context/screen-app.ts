import type { Downloads, ServerAtoms, ServerConnection } from "@dyad/client-runtime";
import type { AlbumRef, ArtistRef, SourceSegment } from "@dyad/domain";
import type { BoxRenderable } from "@opentui/core";
import { Data } from "effect";
import type { Effect, Fiber } from "effect";
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

import type { Action } from "../component/dialog-actions.tsx";
import type { useDownloadAction } from "../component/dialog-downloads.tsx";
import type { usePlaylistActions } from "../routes/playlists/dialog-playlists.tsx";
import type { useLibraryMarks } from "../routes/library/library-marks.ts";
import type { Artwork } from "../component/use-artwork.ts";
import type { usePlayer } from "../playback/use-player.ts";
import type { useCoverVideo } from "../video/video-view.tsx";
import type { useBackdrop } from "../visualizer/backdrop.tsx";
import type { ActionItem, SongItem } from "./action-items.ts";
import { useCommands } from "./keymap.ts";
import type { Command } from "./keymap.ts";
import type { useRouter } from "./router.ts";
import type { useSearch } from "./use-search.ts";

/** What the shell gives each screen */
export class ScreenApp extends Data.Class<{
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  /** The replica of this device, for edits */
  readonly replica: typeof ServerConnection.Service;
  /** `null` while the server is not connected */
  readonly client: typeof ServerConnection.Service | null;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly player: ReturnType<typeof usePlayer>;
  readonly search: ReturnType<typeof useSearch>;
  readonly router: ReturnType<typeof useRouter>;
  readonly breadcrumb: string;
  /** The keys of a screen work while this box has the focus */
  readonly main: RefObject<BoxRenderable | null>;
  readonly segments: ReadonlyArray<SourceSegment>;
  readonly currentSegment: number;
  readonly downloads: typeof Downloads.Service | null;
  readonly itemActions: (item: ActionItem) => ReadonlyArray<Action>;
  readonly downloadAction: ReturnType<typeof useDownloadAction>;
  readonly playlistActions: ReturnType<typeof usePlaylistActions>;
  readonly libraryMarks: ReturnType<typeof useLibraryMarks>;
  readonly backdrop: ReturnType<typeof useBackdrop>;
  readonly artwork: Artwork | null;
  readonly cover: ReturnType<typeof useCoverVideo>;
  readonly width: number;
  readonly bodyHeight: number;
  /** Goes up at each reload */
  readonly reloads: number;
  readonly openArtist: (ref: ArtistRef, name: string | null) => void;
  readonly openAlbum: (ref: AlbumRef, title: string | null, artistRef: ArtistRef | null) => void;
  readonly openPlaylist: (id: string, name: string) => void;
  readonly watchVideo: (item: SongItem) => void;
}> {}

/** Loads the data of a screen again when the user reloads */
export function useReload(app: ScreenApp, refresh: () => void) {
  const seen = useRef(app.reloads);
  useEffect(() => {
    if (seen.current === app.reloads) return;
    seen.current = app.reloads;
    refresh();
  }, [app.reloads]);
}

/** The keys of the shown screen. They win over the keys of the shell and show first in the footer. */
export function useScreenCommands(
  app: ScreenApp,
  bindings: ReadonlyArray<readonly [Command, () => void]>,
) {
  useCommands(bindings, { target: app.main, targetMode: "focus", priority: 1 });
}
