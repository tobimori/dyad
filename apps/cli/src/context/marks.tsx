import type { ServerAtoms } from "@dyad/client-runtime";
import { LibraryMarks } from "@dyad/domain";
import type { LibraryMark, SourceSummary } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

const noMarks = new LibraryMarks({ recordings: {}, albums: {}, artists: {}, disliked: [] });
const MarksContext = createContext(noMarks);

/** The owner's library marks, so that lists show them */
export function MarksProvider(props: {
  readonly atoms: ServerAtoms;
  readonly children: ReactNode;
}) {
  const result = useAtomValue(props.atoms.marks);
  return (
    <MarksContext value={AsyncResult.isSuccess(result) ? result.value : noMarks}>
      {props.children}
    </MarksContext>
  );
}

/** The mark of a song, album or artist, and whether a source is a copy of a disliked song */
export const useMarks = () => {
  const marks = useContext(MarksContext);
  return useMemo(() => {
    const disliked = new Set<string>(marks.disliked);
    return {
      song: (source: SourceSummary) =>
        source.recordingId === null ? undefined : marks.recordings[source.recordingId],
      album: (albumId: string) => marks.albums[albumId],
      artist: (artistId: string) => marks.artists[artistId],
      disliked: (source: SourceSummary) =>
        source.recordingId !== null && disliked.has(source.recordingId),
    };
  }, [marks]);
};

/** `♥` for a favorite, and `+` for a saved song in a list where saved is not the rule */
export const markerOf = (mark: LibraryMark | undefined, showSaved: boolean) => {
  if (mark === "favorite") return "♥";
  return showSaved && mark === "saved" ? "+" : " ";
};
