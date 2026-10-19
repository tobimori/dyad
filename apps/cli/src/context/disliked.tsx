import type { ServerAtoms } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { createContext, useContext, useMemo } from "react";
import type { ReactNode } from "react";

const DislikedContext = createContext<ReadonlySet<string>>(new Set());

/** The recordings of the disliked songs, so that lists show them dim */
export function DislikedProvider(props: {
  readonly atoms: ServerAtoms;
  readonly children: ReactNode;
}) {
  const result = useAtomValue(props.atoms.disliked);
  const disliked = useMemo(
    () => new Set<string>(AsyncResult.isSuccess(result) ? result.value : []),
    [result],
  );
  return <DislikedContext value={disliked}>{props.children}</DislikedContext>;
}

/** Whether a source is a copy of a disliked song */
export const useDisliked = () => {
  const disliked = useContext(DislikedContext);
  return (source: SourceSummary) => source.recordingId !== null && disliked.has(source.recordingId);
};
