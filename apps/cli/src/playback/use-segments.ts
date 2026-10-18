import type { ServerAtoms } from "@dyad/client-runtime";
import type { SourceSegment } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult, Atom } from "effect/reactivity";

const noSegments = Atom.make(AsyncResult.initial());
const none: ReadonlyArray<SourceSegment> = [];

/** The tracklist of a DJ set source, empty while it loads */
export function useSegments(atoms: ServerAtoms, sourceId: string | undefined) {
  const result = useAtomValue(sourceId === undefined ? noSegments : atoms.sourceSegments(sourceId));
  return AsyncResult.isSuccess(result) ? result.value : none;
}
