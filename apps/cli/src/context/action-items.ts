import type { Downloads, ServerAtoms, ServerConnection } from "@dyad/client-runtime";
import type {
  AlbumCard,
  AlbumRef,
  ArtistRef,
  DownloadQuality,
  PlayContext,
  PlaylistSummary,
  SourceSegment,
  SourceSummary,
} from "@dyad/domain";
import { Data } from "effect";
import type { Effect, Fiber } from "effect";

import type { Action } from "../component/dialog-actions.tsx";
import type { usePlayer } from "../playback/use-player.ts";
import type { Route } from "./router.ts";

export class SongItem extends Data.TaggedClass("Song")<{
  readonly source: SourceSummary;
  readonly context: typeof PlayContext.Type;
  /** Plays the song as its list would, for actions that need it to play */
  readonly play: () => void;
  /** The actions of the screen, after the actions of the features */
  readonly extra: ReadonlyArray<Action>;
}> {}

export class AlbumItem extends Data.TaggedClass("Album")<{ readonly album: AlbumCard }> {}

export class ArtistItem extends Data.TaggedClass("Artist")<{ readonly name: string }> {}

export class PlaylistItem extends Data.TaggedClass("Playlist")<{
  readonly playlist: PlaylistSummary;
  readonly onDelete: () => void;
}> {}

/** A track of the DJ set that plays */
export class SegmentItem extends Data.TaggedClass("Segment")<{
  readonly segment: SourceSegment;
}> {}

/** What the actions dialog and the action keys act on */
export type ActionItem = SongItem | AlbumItem | ArtistItem | PlaylistItem | SegmentItem;

/** What the actions of the features can use */
export class ActionApp extends Data.Class<{
  readonly atoms: ServerAtoms;
  /** The replica of this device, for edits */
  readonly replica: typeof ServerConnection.Service;
  /** `null` while the server is not connected */
  readonly client: typeof ServerConnection.Service | null;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly player: ReturnType<typeof usePlayer>;
  readonly route: Route;
  /** The tracklist of the set that plays */
  readonly segments: ReadonlyArray<SourceSegment>;
  readonly downloads: typeof Downloads.Service | null;
  readonly downloadQuality: typeof DownloadQuality.Type;
  readonly openArtist: (ref: ArtistRef, name: string | null) => void;
  readonly openAlbum: (ref: AlbumRef, title: string | null, artistRef: ArtistRef | null) => void;
  readonly searchFor: (query: string) => void;
  readonly watchVideo: (item: SongItem) => void;
}> {}
