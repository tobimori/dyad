import { PlayEventRow, PlaylistEntryRow, PlaylistRow } from "@dyad/domain";
import type {
  CatalogAssertionRow,
  CatalogInputRow,
  HybridLogicalClock,
  PlaylistLink,
  PlaylistLinkState,
  SyncChange,
  SyncRow,
} from "@dyad/domain";
import { Match, Option } from "effect";

const playlistFields = ["name", "link", "linkState", "deleted"] as const;
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
    winners.some(
      (winner) => JSON.stringify(winner.value) !== JSON.stringify(current[winner.field]),
    ) ||
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
          // Each write of a library item or a rating sets all fields
          library_item: (row) =>
            current.table === "library_item" && row.hlc > current.hlc
              ? Option.some<SyncRow>(row)
              : Option.none<SyncRow>(),
          rating: (row) =>
            current.table === "rating" && row.hlc > current.hlc
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
          source_preference: (row) =>
            current.table === "source_preference" && row.hlc > current.hlc
              ? Option.some<SyncRow>(row)
              : Option.none<SyncRow>(),
        }),
      );

/** Sets the given fields with `hlc`, like a write of only these fields on another replica */
export const patchRow = (
  current: PlaylistRow | PlaylistEntryRow,
  patch: {
    readonly name?: string;
    readonly link?: PlaylistLink | null;
    readonly linkState?: PlaylistLinkState | null;
    readonly position?: string;
    readonly deleted?: boolean;
  },
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
          link: patch.link === undefined ? current.link : patch.link,
          linkState: patch.linkState === undefined ? current.linkState : patch.linkState,
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
      "library_item.set": (set) => ({ table: set.row.table, id: set.row.id }),
      "rating.set": (set) => ({ table: set.row.table, id: set.row.id }),
      "play_event.append": (append) => ({ table: append.row.table, id: append.row.id }),
      "playlist.create": (create) => ({ table: create.row.table, id: create.row.id }),
      "playlist_entry.add": (add) => ({ table: add.row.table, id: add.row.id }),
      "playlist.patch": (patch) => ({ table: "playlist" as const, id: patch.id }),
      "playlist_entry.patch": (patch) => ({ table: "playlist_entry" as const, id: patch.id }),
      "source_preference.set": (set) => ({ table: set.row.table, id: set.row.id }),
    }),
  );

/** The row after `change`. `None`: nothing changes, also when a patch finds no row. */
export const applyChange = (current: SyncRow | undefined, change: SyncChange) =>
  Match.value(change).pipe(
    Match.discriminatorsExhaustive("kind")({
      "library_item.set": (set) => mergeRow(current, set.row),
      "rating.set": (set) => mergeRow(current, set.row),
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
      "source_preference.set": (set) => mergeRow(current, set.row),
    }),
  );

const parseVersion = (revision: string | null) => Number(revision?.replace("parse:v", "") ?? 0);

// Between `parse` assertions, a newer parser wins first, so that a replica with an older parser
// cannot overwrite a newer parse. Then the newer HLC wins.
const assertionOrder = (row: CatalogAssertionRow) =>
  [row.origin === "parse" ? parseVersion(row.originRevision) : 0, row.hlc] as const;

/**
 * Merges a catalog input row from another server replica into the stored row of the same table
 * and ID. The newer write wins. `None`: the stored row stays.
 */
export const mergeCatalogRow = (
  current: CatalogInputRow | undefined,
  incoming: CatalogInputRow,
) => {
  if (current === undefined) return Option.some(incoming);
  if (current.table !== incoming.table) return Option.none<CatalogInputRow>();

  if (current.table === "catalog_assertion" && incoming.table === "catalog_assertion") {
    const [currentParse, currentHlc] = assertionOrder(current);
    const [incomingParse, incomingHlc] = assertionOrder(incoming);
    const newer =
      incomingParse > currentParse || (incomingParse === currentParse && incomingHlc > currentHlc);
    return newer ? Option.some<CatalogInputRow>(incoming) : Option.none<CatalogInputRow>();
  }
  return incoming.hlc > current.hlc ? Option.some(incoming) : Option.none<CatalogInputRow>();
};
