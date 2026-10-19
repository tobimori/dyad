import { titleOf } from "@dyad/client-runtime";
import type { ServerAtoms, ServerConnection } from "@dyad/client-runtime";
import type { LibraryMark, SourceSummary } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { Effect } from "effect";
import type { Fiber } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { commands } from "../context/keymap.ts";
import { useToast } from "../ui/toast.tsx";
import { Action } from "./dialog-actions.tsx";

/** Save, favorite, dislike and remove for a song, with the labels of its current mark */
export function useLibraryMarks(props: {
  readonly atoms: ServerAtoms;
  /** The replica of this device */
  readonly replica: typeof ServerConnection.Service;
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const toast = useToast();
  const library = useAtomValue(props.atoms.library);
  // An entry has the merge root; a source of the song can have another recording of the group
  const marks = useMemo(
    () =>
      new Map<string, LibraryMark>(
        (AsyncResult.isSuccess(library) ? library.value : []).flatMap((entry) => {
          const mark = entry.favorite ? "favorite" : "saved";
          const sourceRecording = entry.source?.recordingId ?? null;
          return [
            [entry.recordingId, mark],
            ...(sourceRecording === null ? [] : [[sourceRecording, mark] as const]),
          ];
        }),
      ),
    [library],
  );

  return (source: SourceSummary) => {
    const recordingId = source.recordingId;
    if (recordingId === null) return [];
    const name = titleOf(source);
    const set = (mark: LibraryMark | null, done: string) => () =>
      props.run(
        props.replica
          .setLibraryMark({
            entityType: "recording",
            entityId: recordingId,
            mark,
            sourceId: source.id,
          })
          .pipe(
            Effect.match({
              onSuccess: () => toast("notice", done),
              onFailure: () => toast("error", "Cannot change the library"),
            }),
          ),
      );

    const mark = marks.get(recordingId);
    return [
      mark === undefined
        ? new Action({
            command: commands.saveToLibrary,
            label: "Save to library",
            run: set("saved", `Saved ${name}`),
          })
        : new Action({
            command: commands.removeFromLibrary,
            label: "Remove from library",
            run: set(null, `Removed ${name} from the library`),
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
      new Action({
        command: commands.dislike,
        label: "Dislike",
        run: set("disliked", `Disliked ${name}`),
      }),
    ];
  };
}
