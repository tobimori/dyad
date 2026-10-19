import {
  libraryItem,
  libraryRemoteTrack,
  playlist,
  playlistEntry,
  recording,
  source,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  CurrentPrincipal,
  PlaylistEntryRow,
  PlaylistNotFound,
  PlaylistRow,
  RecordingId,
  libraryView,
} from "@dyad/domain";
import type { PlaylistLink, PlaylistLinkState, UserId } from "@dyad/domain";
import { HlcClock, libraryItemId, patchRow } from "@dyad/sync";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { Array as Arr, Clock, Effect, Option, Schema } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import { uuidV5 } from "./ids.ts";
import { providerOrder } from "./source-preference.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { nextChangeSeq } from "./sync-counter.ts";
import { readRow, writeRow } from "./replication.ts";

/**
 * The server's own writes of library items and playlists go through this module, so that each
 * changed row gets an HLC and a `change_seq`. With `complete`, the other items of `origin` are
 * removed. A removed item in `removedInDyad` stays removed: the removal in Dyad wins.
 */
export const setMembership = (
  userId: string,
  origin: string,
  recordingIds: ReadonlySet<string>,
  complete: boolean,
  removedInDyad: ReadonlySet<string> = new Set(),
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* db
      .select()
      .from(libraryItem)
      .where(and(eq(libraryItem.userId, userId), eq(libraryItem.origin, origin)));
    const live = new Set(rows.filter((row) => !row.deleted).map((row) => row.entityId));

    const removedRows = new Set(rows.filter((row) => row.deleted).map((row) => row.entityId));
    const added = [...recordingIds].filter(
      (id) => !live.has(id) && !(removedRows.has(id) && removedInDyad.has(id)),
    );
    const removed = complete
      ? rows.filter((row) => !row.deleted && !recordingIds.has(row.entityId))
      : [];
    if (added.length === 0 && removed.length === 0) return { added: 0, removed: 0 };

    const changeSeq = yield* nextChangeSeq;
    yield* Effect.forEach(
      added,
      (entityId) =>
        Effect.gen(function* () {
          const id = yield* libraryItemId({ userId, entityType: "recording", entityId, origin });
          const change = { addedAt: now, hlc: yield* clock.next, deleted: false, changeSeq };

          yield* db
            .insert(libraryItem)
            .values({ id, userId, entityType: "recording", entityId, origin, ...change })
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

/** Adds a playlist of a remote playlist, linked to it */
export const addLinkedPlaylist = (
  ownerId: UserId,
  id: string,
  name: string,
  origin: string,
  link: PlaylistLink,
) =>
  Effect.gen(function* () {
    const clock = yield* HlcClock;
    const row = new PlaylistRow({
      table: "playlist",
      id,
      ownerId,
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
export const unlinkPlaylists = (ownerId: string, provider: string, keep: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rows = yield* db
      .select({ id: playlist.id, link: playlist.link })
      .from(playlist)
      .where(
        and(
          eq(playlist.ownerId, ownerId),
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
const loadLibraryView = (userId: UserId, boundIds: ReadonlyArray<string>) =>
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
      userId,
      inArray(source.recordingId, [...new Set([...boundIds, ...recordings.map((row) => row.id)])]),
    );
    const remoteTracks = yield* db
      .select()
      .from(libraryRemoteTrack)
      .where(
        and(
          eq(libraryRemoteTrack.userId, userId),
          inArray(libraryRemoteTrack.recordingId, boundIds),
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
      providerOrder: yield* providerOrder(userId),
    });
  });

export const listPlaylistEntries = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;

    const [owned] = yield* db
      .select({ link: playlist.link })
      .from(playlist)
      .where(
        and(
          eq(playlist.id, playlistId),
          eq(playlist.ownerId, principal.userId),
          eq(playlist.deleted, false),
        ),
      );
    if (owned === undefined) return yield* new PlaylistNotFound();

    const entries = yield* db
      .select()
      .from(playlistEntry)
      .where(and(eq(playlistEntry.playlistId, playlistId), eq(playlistEntry.deleted, false)))
      .orderBy(asc(playlistEntry.position), asc(playlistEntry.id));
    const view = yield* loadLibraryView(
      principal.userId,
      entries.map((entry) => entry.recordingId),
    );
    return view.playlistEntries(
      entries,
      owned.link?.direction === "two-way" ? owned.link.provider : null,
    );
  });

/** The saved songs */
export const listLibrary = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;
  const items = yield* db
    .select({ entityId: libraryItem.entityId, addedAt: libraryItem.addedAt })
    .from(libraryItem)
    .where(
      and(
        eq(libraryItem.userId, principal.userId),
        eq(libraryItem.deleted, false),
        eq(libraryItem.entityType, "recording"),
      ),
    );
  const view = yield* loadLibraryView(
    principal.userId,
    items.map((item) => item.entityId),
  );
  return view.libraryEntries(items);
});
