import { PlayEventRow, PlaylistEntryRow, PlaylistRow } from "@dyad/domain";
import type { HybridLogicalClock, SyncChange, SyncRow } from "@dyad/domain";
import { Match, Option } from "effect";

const playlistFields = ["name", "deleted"] as const;
const entryFields = ["position", "deleted"] as const;

const clockOf = (
  row: {
    readonly hlc: HybridLogicalClock;
    readonly fieldHlc: { readonly [field: string]: HybridLogicalClock } | null;
  },
  field: string,
) => row.fieldHlc?.[field] ?? row.hlc;

/**
 * Last writer wins per field. The row `hlc` is the highest field clock, and `fieldHlc` keeps only
 * the clocks that differ from it, so that equal states have equal rows.
 */
const mergeFields = <R extends PlaylistRow | PlaylistEntryRow, F extends keyof R & string>(
  current: R,
  incoming: R,
  fields: ReadonlyArray<F>,
  make: (row: R) => R,
) => {
  const winners = fields.map((field) => {
    const newer = clockOf(incoming, field) > clockOf(current, field);
    const row = newer ? incoming : current;
    return { field, value: row[field], clock: clockOf(row, field) };
  });
  const hlc = winners.map((winner) => winner.clock).reduce((a, b) => (b > a ? b : a));
  const later = winners.filter((winner) => winner.clock !== hlc);
  const fieldHlc =
    later.length === 0
      ? null
      : Object.fromEntries(later.map((winner) => [winner.field, winner.clock]));

  const changed =
    winners.some((winner) => winner.value !== current[winner.field]) ||
    hlc !== current.hlc ||
    JSON.stringify(fieldHlc) !== JSON.stringify(current.fieldHlc);
  if (!changed) return Option.none<SyncRow>();

  const values = Object.fromEntries(winners.map((winner) => [winner.field, winner.value]));
  return Option.some(make({ ...current, ...values, hlc, fieldHlc }));
};

/**
 * Merges the state of a row from another replica into the stored row of the same table and ID.
 * The result does not depend on the order or the number of arrivals. `None`: the stored row stays.
 * Immutable fields keep their first value.
 */
export const mergeRow = (current: SyncRow | undefined, incoming: SyncRow) =>
  current === undefined
    ? Option.some(incoming)
    : Match.value(incoming).pipe(
        Match.discriminatorsExhaustive("table")({
          // Plays never change after insert, except `scrobbled` from false to true
          play_event: (row) =>
            current.table === "play_event" && row.scrobbled && !current.scrobbled
              ? Option.some<SyncRow>(new PlayEventRow({ ...current, scrobbled: true }))
              : Option.none<SyncRow>(),
          // Only the import writes library items, and it writes all fields
          library_item: (row) =>
            current.table === "library_item" && row.hlc > current.hlc
              ? Option.some<SyncRow>(row)
              : Option.none<SyncRow>(),
          playlist: (row) =>
            current.table === "playlist"
              ? mergeFields(current, row, playlistFields, (merged) => new PlaylistRow(merged))
              : Option.none<SyncRow>(),
          playlist_entry: (row) =>
            current.table === "playlist_entry"
              ? mergeFields(current, row, entryFields, (merged) => new PlaylistEntryRow(merged))
              : Option.none<SyncRow>(),
        }),
      );

/** Sets the given fields with `hlc`, like a write of only these fields on another replica */
export const patchRow = (
  current: PlaylistRow | PlaylistEntryRow,
  patch: { readonly name?: string; readonly position?: string; readonly deleted?: boolean },
  hlc: HybridLogicalClock,
) => {
  const set = Object.entries(patch).flatMap(([field, value]) =>
    value === undefined ? [] : [field],
  );
  const clocks = (fields: ReadonlyArray<string>) =>
    Object.fromEntries(
      fields.map((field) => [field, set.includes(field) ? hlc : clockOf(current, field)]),
    );
  const deleted = patch.deleted ?? current.deleted;

  return current.table === "playlist"
    ? mergeRow(
        current,
        new PlaylistRow({
          ...current,
          name: patch.name ?? current.name,
          deleted,
          hlc,
          fieldHlc: clocks(playlistFields),
        }),
      )
    : mergeRow(
        current,
        new PlaylistEntryRow({
          ...current,
          position: patch.position ?? current.position,
          deleted,
          hlc,
          fieldHlc: clocks(entryFields),
        }),
      );
};

/** The row that a change writes */
export const changeTarget = (change: SyncChange) =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      "play_event.append": (append) => ({ table: append.row.table, id: append.row.id }),
      "playlist.create": (create) => ({ table: create.row.table, id: create.row.id }),
      "playlist_entry.add": (add) => ({ table: add.row.table, id: add.row.id }),
      "playlist.patch": (patch) => ({ table: "playlist" as const, id: patch.id }),
      "playlist_entry.patch": (patch) => ({ table: "playlist_entry" as const, id: patch.id }),
    }),
  );

/** The row after `change`. `None`: nothing changes, also when a patch finds no row. */
export const applyChange = (current: SyncRow | undefined, change: SyncChange) =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      "play_event.append": (append) => mergeRow(current, append.row),
      "playlist.create": (create) => mergeRow(current, create.row),
      "playlist_entry.add": (add) => mergeRow(current, add.row),
      "playlist.patch": (patch) =>
        current?.table === "playlist"
          ? patchRow(current, patch, patch.hlc)
          : Option.none<SyncRow>(),
      "playlist_entry.patch": (patch) =>
        current?.table === "playlist_entry"
          ? patchRow(current, patch, patch.hlc)
          : Option.none<SyncRow>(),
    }),
  );
