import {
  album,
  artist,
  libraryItem,
  libraryRemoteTrack,
  playlist,
  playlistEntry,
  recording,
  source,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  LibraryItemRow,
  PlaylistEntryRow,
  PlaylistNotFound,
  PlaylistRow,
  RecordingId,
  libraryView,
} from "@dyad/domain";
import type { LibraryEntityType, LibraryMark, PlaylistLink, PlaylistLinkState } from "@dyad/domain";
import { HlcClock, libraryItemId, patchRow } from "@dyad/sync";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { Array as Arr, Clock, Effect, Option, Schema } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import { uuidV5 } from "./ids.ts";
import { providerOrder } from "./source-preference.ts";
import { addReferencedSources, playableSources, sourceSummary } from "./sources.ts";
import { nextChangeSeq } from "./sync-counter.ts";
import { readRow, writeRow } from "./replication.ts";

/**
 * The server's own writes of library items and playlists go through this module, so that each
 * changed row gets an HLC and a `change_seq`. The rows of an import origin mirror the provider;
 * with `complete`, the other items of `origin` are removed. A `user` row decides over them.
 */
export const setMembership = (
  origin: string,
  recordingIds: ReadonlySet<string>,
  complete: boolean,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* db.select().from(libraryItem).where(eq(libraryItem.origin, origin));
    const live = new Set(rows.filter((row) => !row.deleted).map((row) => row.entityId));

    const removedRows = new Map(
      rows.filter((row) => row.deleted).map((row) => [row.entityId, row.id]),
    );
    const added = [...recordingIds].filter((id) => !live.has(id));
    const removed = complete
      ? rows.filter((row) => !row.deleted && !recordingIds.has(row.entityId))
      : [];
    if (added.length === 0 && removed.length === 0) return { added: 0, removed: 0 };

    const changeSeq = yield* nextChangeSeq;
    yield* Effect.forEach(
      added,
      (entityId) =>
        Effect.gen(function* () {
          // A row from before single user has another ID
          const id =
            removedRows.get(entityId) ??
            (yield* libraryItemId({ entityType: "recording", entityId, origin }));
          const change = {
            addedAt: now,
            mark: "saved" as const,
            hlc: yield* clock.next,
            deleted: false,
            changeSeq,
          };

          yield* db
            .insert(libraryItem)
            .values({ id, entityType: "recording", entityId, origin, ...change })
            .onConflictDoUpdate({ target: libraryItem.id, set: change });
        }),
      { discard: true },
    );

    if (removed.length > 0) {
      const ids = removed.map((row) => row.id);
      yield* db
        .update(libraryItem)
        .set({ deleted: true, hlc: yield* clock.next, changeSeq })
        .where(inArray(libraryItem.id, ids));
    }

    return { added: added.length, removed: removed.length };
  });

const markTables = { recording, album, artist };

// The entity IDs of the merge group of an entity
const groupOf = (entityType: LibraryEntityType, entityId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const table = markTables[entityType];
    const [row] = yield* db
      .select({ mergedIntoId: table.mergedIntoId })
      .from(table)
      .where(eq(table.id, entityId));
    const root = row?.mergedIntoId ?? entityId;
    const members = yield* db
      .select({ id: table.id })
      .from(table)
      .where(or(eq(table.id, root), eq(table.mergedIntoId, root)));
    return [...new Set([entityId, root, ...members.map((member) => member.id)])];
  });

// The newest user row decides. Else an import decides: favorite if one is, else saved.
const effectiveMark = (
  rows: ReadonlyArray<{
    readonly origin: string;
    readonly mark: LibraryMark;
    readonly hlc: string;
  }>,
) => {
  const own = rows
    .filter((row) => row.origin === "user")
    .reduce<(typeof rows)[number] | undefined>(
      (newest, row) => (newest === undefined || row.hlc > newest.hlc ? row : newest),
      undefined,
    );
  if (own !== undefined) return own.mark;
  return rows.some((row) => row.mark === "favorite") ? "favorite" : "saved";
};

/** The effective mark of each marked song, by merge root, with the marked recording IDs */
export const recordingMarks = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db
    .select({
      entityId: libraryItem.entityId,
      origin: libraryItem.origin,
      mark: libraryItem.mark,
      hlc: libraryItem.hlc,
      addedAt: libraryItem.addedAt,
    })
    .from(libraryItem)
    .where(and(eq(libraryItem.deleted, false), eq(libraryItem.entityType, "recording")));
  const ids = [...new Set(rows.map((row) => row.entityId))];
  const bound =
    ids.length === 0
      ? []
      : yield* db
          .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
          .from(recording)
          .where(inArray(recording.id, ids));
  const rootOf = new Map(bound.map((row) => [row.id, row.mergedIntoId ?? row.id]));
  const groups = Arr.groupBy(rows, (row) => rootOf.get(row.entityId) ?? row.entityId);
  return new Map(
    Object.entries(groups).map(([root, group]) => [
      root,
      {
        mark: effectiveMark(group),
        addedAt: Math.min(...group.map((row) => row.addedAt)),
        entityIds: [...new Set(group.map((row) => row.entityId))],
      },
    ]),
  );
});

/** Whether a mark puts the entity in the library */
export const inLibrary = (mark: LibraryMark) => mark === "saved" || mark === "favorite";

/**
 * Sets the owner's mark of an entity. `null` takes it out of the library: a `removed` row when an
 * import has the entity, so that the next import does not add it again, else no user row.
 */
export const setLibraryMark = (
  entityType: LibraryEntityType,
  entityId: string,
  mark: LibraryMark | null,
  sourceId: string | null,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (entityType === "recording")
      yield* addReferencedSources([{ sourceId, recordingId: entityId }]);
    const clock = yield* HlcClock;
    const members = yield* groupOf(entityType, entityId);
    const rows = yield* db
      .select()
      .from(libraryItem)
      .where(and(eq(libraryItem.entityType, entityType), inArray(libraryItem.entityId, members)));
    const ownRows = rows.filter((row) => row.origin === "user");
    const changeSeq = yield* nextChangeSeq;

    if (mark === null && !rows.some((row) => row.origin !== "user" && !row.deleted)) {
      yield* Effect.forEach(
        ownRows.filter((row) => !row.deleted),
        (row) =>
          Effect.gen(function* () {
            const { changeSeq: _seq, ...values } = row;
            const hlc = yield* clock.next;
            yield* writeRow(
              new LibraryItemRow({ table: "library_item", ...values, hlc, deleted: true }),
              changeSeq,
            );
          }),
        { discard: true },
      );
      return;
    }

    const own = ownRows.find((row) => row.entityId === entityId);
    yield* writeRow(
      new LibraryItemRow({
        table: "library_item",
        id: own?.id ?? (yield* libraryItemId({ entityType, entityId, origin: "user" })),
        entityType,
        entityId,
        origin: "user",
        mark: mark ?? "removed",
        addedAt: own === undefined || own.deleted ? yield* Clock.currentTimeMillis : own.addedAt,
        hlc: yield* clock.next,
        deleted: false,
      }),
      changeSeq,
    );
  });

/** Adds a playlist of a remote playlist, linked to it */
export const addLinkedPlaylist = (id: string, name: string, origin: string, link: PlaylistLink) =>
  Effect.gen(function* () {
    const clock = yield* HlcClock;
    const row = new PlaylistRow({
      table: "playlist",
      id,
      name,
      origin,
      link,
      linkState: null,
      createdAt: yield* Clock.currentTimeMillis,
      hlc: yield* clock.next,
      fieldHlc: null,
      deleted: false,
    });
    yield* writeRow(row, yield* nextChangeSeq);
  });

/** Sets the fields of a playlist with a new HLC. Returns whether the row changed. */
export const patchPlaylist = (
  id: string,
  // An undefined field stays
  fields: {
    readonly name?: string | undefined;
    readonly link?: PlaylistLink | null | undefined;
    readonly linkState?: PlaylistLinkState | null | undefined;
    readonly deleted?: boolean | undefined;
  },
) =>
  Effect.gen(function* () {
    const clock = yield* HlcClock;
    const current = yield* readRow("playlist", id);
    if (current?.table !== "playlist") return false;

    const next = patchRow(current, fields, yield* clock.next);
    if (Option.isNone(next)) return false;
    yield* writeRow(next.value, yield* nextChangeSeq);
    return true;
  });

/** The canonical recording of each of `recordingIds` */
export const rootsOf = (recordingIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, [...new Set(recordingIds)]));
    const roots = new Map(rows.map((row) => [row.id, row.mergedIntoId ?? row.id]));
    return (id: string) => roots.get(id) ?? id;
  });

// The `n`th occurrence of each key, so that a list can have a recording more than once
const occurrences = (keys: ReadonlyArray<string>) => {
  const counts = new Map<string, number>();
  return keys.map((key) => {
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    return `${key}#${n}`;
  });
};

/**
 * Applies the changes of a remote playlist since `base` to the entries, so that the edits in Dyad
 * stay. `null`: the base is not known, so the provider has no changes. Entries match by canonical
 * recording and occurrence. Returns the number of changed entries.
 */
export const mergeRemoteEntries = (
  playlistId: string,
  base: ReadonlyArray<string> | null,
  remote: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const now = yield* Clock.currentTimeMillis;

    const stored = yield* Effect.forEach(
      yield* db
        .select()
        .from(playlistEntry)
        .where(eq(playlistEntry.playlistId, playlistId))
        .orderBy(asc(playlistEntry.position), asc(playlistEntry.id)),
      (row) =>
        Schema.decodeUnknownEffect(PlaylistEntryRow)({ ...row, table: "playlist_entry" }).pipe(
          Effect.orDie,
        ),
    );
    const live = stored.filter((row) => !row.deleted);

    const keyOf = yield* rootsOf([
      ...live.map((row) => row.recordingId),
      ...remote,
      ...(base ?? []),
    ]);

    const remoteTokens = occurrences(remote.map(keyOf));
    const baseTokens = base === null ? remoteTokens : occurrences(base.map(keyOf));
    const inRemote = new Set(remoteTokens);
    const inBase = new Set(baseTokens);

    // The provider removed the later occurrences of a recording: remove as many from the end
    const removals = new Map<string, number>();
    for (const token of baseTokens.filter((token) => !inRemote.has(token))) {
      const key = token.slice(0, token.lastIndexOf("#"));
      removals.set(key, (removals.get(key) ?? 0) + 1);
    }
    const removed = new Set<string>();
    for (const row of live.toReversed()) {
      const key = keyOf(row.recordingId);
      const count = removals.get(key) ?? 0;
      if (count === 0) continue;
      removals.set(key, count - 1);
      removed.add(row.id);
    }
    const kept = live.filter((row) => !removed.has(row.id));
    const entryOf = new Map(Arr.zip(occurrences(kept.map((row) => keyOf(row.recordingId))), kept));
    const positions = new Map(kept.map((row) => [row.id, row.position]));

    // A changed order of the common entries on the provider moves them within their own places
    const common = remoteTokens.filter((token) => inBase.has(token) && entryOf.has(token));
    const baseCommon = baseTokens.filter((token) => inRemote.has(token) && entryOf.has(token));
    if (common.some((token, index) => token !== baseCommon[index])) {
      const moved = new Set(common.map((token) => entryOf.get(token)));
      const slots = kept.filter((row) => moved.has(row)).map((row) => row.position);
      for (const [index, token] of common.entries()) {
        const row = entryOf.get(token);
        const slot = slots[index];
        if (row !== undefined && slot !== undefined) positions.set(row.id, slot);
      }
    }

    // An added entry goes after the entry of the remote song before it
    const ids = new Set(stored.map((row) => row.id));
    const added: Array<PlaylistEntryRow> = [];
    let previous: string | null = null;
    for (const [index, token] of remoteTokens.entries()) {
      const recordingId = remote[index] ?? "";
      if (inBase.has(token)) {
        const row = entryOf.get(token);
        if (row !== undefined) previous = positions.get(row.id) ?? previous;
        continue;
      }

      const following = [...positions.values(), ...added.map((row) => row.position)]
        .filter((position) => previous === null || position > previous)
        .toSorted()[0];
      const position = generateKeyBetween(previous, following ?? null);
      let n = 1;
      let id = yield* uuidV5(`playlist_entry:${playlistId}:${recordingId}:${n}`);
      while (ids.has(id)) {
        n += 1;
        id = yield* uuidV5(`playlist_entry:${playlistId}:${recordingId}:${n}`);
      }
      ids.add(id);
      added.push(
        new PlaylistEntryRow({
          table: "playlist_entry",
          id,
          playlistId,
          recordingId: RecordingId.make(recordingId),
          position,
          addedAt: now,
          hlc: yield* clock.next,
          fieldHlc: null,
          deleted: false,
        }),
      );
      previous = position;
    }

    const patched = yield* Effect.forEach(live, (row) =>
      Effect.gen(function* () {
        const position = positions.get(row.id) ?? row.position;
        if (!removed.has(row.id) && position === row.position) return Option.none();
        const fields = removed.has(row.id) ? { deleted: true } : { position };
        return patchRow(row, fields, yield* clock.next);
      }),
    );
    const changes = [...patched.flatMap((row) => Option.toArray(row)), ...added];
    if (changes.length === 0) return 0;

    const changeSeq = yield* nextChangeSeq;
    yield* Effect.forEach(changes, (row) => writeRow(row, changeSeq), { discard: true });
    return changes.length;
  });

/**
 * Unlinks the playlists of `provider` whose remote playlist is not in `keep`. The playlists stay.
 * Returns their IDs.
 */
export const unlinkPlaylists = (provider: string, keep: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select({ id: playlist.id, link: playlist.link })
      .from(playlist)
      .where(
        and(
          eq(playlist.deleted, false),
          sql`json_extract(${playlist.link}, '$.provider') = ${provider}`,
        ),
      );
    // A two-way link without a provider playlist yet waits for its first write
    const unlinked = rows.filter(
      (row) => row.link?.remoteId != null && !keep.has(row.link.remoteId),
    );
    yield* Effect.forEach(unlinked, (row) => patchPlaylist(row.id, { link: null }), {
      discard: true,
    });
    return unlinked.map((row) => row.id);
  });

// The canonical recording is `coalesce(merged_into_id, id)`
const loadLibraryView = (boundIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;

    const bound = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, boundIds));
    const rootOf = new Map(bound.map((row) => [row.id, row.mergedIntoId ?? row.id]));
    const roots = [...new Set(boundIds.map((id) => rootOf.get(id) ?? id))];

    // Other recordings in the same groups can bring sources that the user did not save
    const recordings = yield* db
      .select()
      .from(recording)
      .where(or(inArray(recording.id, roots), inArray(recording.mergedIntoId, roots)));

    const sources = yield* playableSources(
      inArray(source.recordingId, [...new Set([...boundIds, ...recordings.map((row) => row.id)])]),
    );
    const remoteTracks = yield* db
      .select()
      .from(libraryRemoteTrack)
      .where(
        and(
          inArray(libraryRemoteTrack.recordingId, boundIds),
          eq(libraryRemoteTrack.deleted, false),
        ),
      );

    return libraryView({
      recordings,
      sources: sources.map((row) => ({
        recordingId: row.source.recordingId,
        lossless: row.variant.lossless,
        summary: sourceSummary(row),
      })),
      remoteTracks,
      providerOrder: yield* providerOrder,
    });
  });

export const listPlaylistEntries = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;

    const [owned] = yield* db
      .select({ link: playlist.link })
      .from(playlist)
      .where(and(eq(playlist.id, playlistId), eq(playlist.deleted, false)));
    if (owned === undefined) return yield* new PlaylistNotFound();

    const entries = yield* db
      .select()
      .from(playlistEntry)
      .where(and(eq(playlistEntry.playlistId, playlistId), eq(playlistEntry.deleted, false)))
      .orderBy(asc(playlistEntry.position), asc(playlistEntry.id));
    const view = yield* loadLibraryView(entries.map((entry) => entry.recordingId));
    return view.playlistEntries(
      entries,
      owned.link?.direction === "two-way" ? owned.link.provider : null,
    );
  });

/** Each song with its best copy, for a page that lists songs */
export const songEntries = (recordingIds: ReadonlyArray<string>) =>
  recordingIds.length === 0
    ? Effect.succeed([])
    : loadLibraryView(recordingIds).pipe(
        Effect.map((view) =>
          view.libraryEntries(recordingIds.map((entityId) => ({ entityId, addedAt: 0 }))),
        ),
      );

/** The saved and favorite songs */
export const listLibrary = Effect.gen(function* () {
  const marks = [...(yield* recordingMarks).values()].filter((group) => inLibrary(group.mark));
  const view = yield* loadLibraryView(marks.flatMap((group) => group.entityIds));
  return view.libraryEntries(
    marks.flatMap((group) =>
      group.entityIds.map((entityId) => ({
        entityId,
        addedAt: group.addedAt,
        favorite: group.mark === "favorite",
      })),
    ),
  );
});
