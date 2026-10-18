import { PlayEventRow } from "@dyad/domain";
import type { SyncRow } from "@dyad/domain";
import { Option } from "effect";

/**
 * Merges the state of a row from another replica into the stored row of the same table and ID.
 * The result does not depend on the order or the number of arrivals. `None`: the stored row stays.
 */
export const mergeRow = (current: SyncRow | undefined, incoming: SyncRow) => {
  if (current === undefined) return Option.some<SyncRow>(incoming);

  // Plays never change after insert, except `scrobbled` from false to true
  if (incoming.table === "play_event") {
    return current.table === "play_event" && incoming.scrobbled && !current.scrobbled
      ? Option.some(new PlayEventRow({ ...current, scrobbled: true }))
      : Option.none();
  }

  // Last writer wins per field. Without `field_hlc`, all fields of a row have the row `hlc`.
  return current.table !== "play_event" && incoming.hlc > current.hlc
    ? Option.some(incoming)
    : Option.none();
};
