import { titleOf } from "@dyad/client-runtime";
import type { ServerConnection } from "@dyad/client-runtime";
import { MarkedSong } from "@dyad/domain";
import type { LibraryEntityType, LibraryMark, SourceSummary } from "@dyad/domain";
import { Effect } from "effect";
import type { Fiber } from "effect";

import { SongItem } from "../context/action-items.ts";
import type { ActionApp, ActionItem } from "../context/action-items.ts";
import { useMarks } from "../context/marks.tsx";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";

/** Save, favorite, dislike and remove for a song, an album or an artist, by its current mark */
export function useLibraryMarks(props: {
  /** The replica of this device */
  readonly replica: typeof ServerConnection.Service;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const toast = useToast();
  const marks = useMarks();

  const setter =
    (entityType: LibraryEntityType, entityId: string, songs: ReadonlyArray<SourceSummary>) =>
    (mark: LibraryMark | null, done: string) =>
    () =>
      props.run(
        props.replica
          .setLibraryMark({
            entityType,
            entityId,
            mark,
            songs: songs.flatMap((song) =>
              song.recordingId === null
                ? []
                : [new MarkedSong({ recordingId: song.recordingId, sourceId: song.id })],
            ),
          })
          .pipe(
            Effect.match({
              onSuccess: () => toast("notice", done),
              onFailure: () => toast("error", "Cannot change the library"),
            }),
          ),
      );

  const dislike = (
    mark: LibraryMark | undefined,
    set: ReturnType<typeof setter>,
    command: Command,
    name: string,
    skipped: string,
  ) =>
    mark === "disliked"
      ? new Action({
          command,
          label: "Remove dislike",
          run: set(null, `Removed the dislike of ${name}`),
        })
      : new Action({
          command,
          label: "Dislike",
          run: set("disliked", `Disliked ${name}. ${skipped}`),
        });

  return {
    song: (source: SourceSummary) => {
      const recordingId = source.recordingId;
      if (recordingId === null) return [];
      const name = titleOf(source);
      const set = setter("recording", recordingId, [source]);
      const mark = marks.song(source);
      return [
        mark !== "saved" && mark !== "favorite"
          ? new Action({
              command: commands.saveToLibrary,
              label: "Save to library",
              run: set("saved", `Saved ${name}`),
            })
          : new Action({
              command: commands.removeFromLibrary,
              label: "Remove from library",
              run: set("removed", `Removed ${name} from the library`),
            }),
        mark === "favorite"
          ? new Action({
              command: commands.favorite,
              label: "Remove from favorites",
              run: set("saved", `Removed ${name} from the favorites`),
            })
          : new Action({
              command: commands.favorite,
              label: "Favorite",
              run: set("favorite", `Added ${name} to the favorites`),
            }),
        dislike(mark, set, commands.dislike, name, "Radio and shuffle skip it."),
      ];
    },

    /** `tracks`: the songs of the album, which a save saves */
    album: (albumId: string, name: string, tracks: ReadonlyArray<SourceSummary>) => {
      const set = setter("album", albumId, tracks);
      const mark = marks.album(albumId);
      return [
        mark === "saved" || mark === "favorite"
          ? new Action({
              command: commands.saveAlbum,
              label: "Remove the album from the library",
              run: set("removed", `Removed ${name} from the library`),
            })
          : new Action({
              command: commands.saveAlbum,
              label: "Save the album",
              run: set("saved", `Saved ${name} and its ${tracks.length} songs`),
            }),
        mark === "favorite"
          ? new Action({
              command: commands.favoriteAlbum,
              label: "Remove the album from favorites",
              run: set("saved", `Removed ${name} from the favorites`),
            })
          : new Action({
              command: commands.favoriteAlbum,
              label: "Favorite the album",
              run: set("favorite", `Added ${name} to the favorites`),
            }),
        dislike(mark, set, commands.dislikePage, name, "Radio and shuffle skip its songs."),
      ];
    },

    artist: (artistId: string, name: string) => {
      const set = setter("artist", artistId, []);
      const mark = marks.artist(artistId);
      return [
        mark === "favorite"
          ? new Action({
              command: commands.followArtist,
              label: "Unfollow",
              run: set(null, `Unfollowed ${name}`),
            })
          : new Action({
              command: commands.followArtist,
              label: "Follow",
              run: set("favorite", `Followed ${name}`),
            }),
        dislike(mark, set, commands.dislikePage, name, "Radio and shuffle skip the artist."),
      ];
    },
  };
}

/** Save, favorite and dislike for a song */
export function useMarkActions(app: ActionApp) {
  const marks = useLibraryMarks({ replica: app.replica, run: app.run });
  return (item: ActionItem) => (item instanceof SongItem ? marks.song(item.source) : []);
}
