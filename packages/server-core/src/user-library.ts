import {
  libraryItem,
  libraryRemoteTrack,
  playlist,
  playlistEntry,
  recording,
  source,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, PlaylistNotFound, PlaylistSummary, libraryView } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { HlcClock } from "@dyad/sync";
import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { Array as Arr, Clock, Effect } from "effect";
import { generateNKeysBetween } from "fractional-indexing";

import { uuidV5 } from "./ids.ts";
import { playableSources, sourceSummary } from "./sources.ts";
import { nextChangeSeq } from "./sync-counter.ts";

const accountPrefix = "account:";

export const accountOrigin = (provider: string) => `${accountPrefix}${provider}`;

/**
 * All writes of library items and playlists go through this module, so that each changed row gets
 * an HLC and a `change_seq`. With `complete`, the other items of `origin` are removed.
 */
export const setMembership = (
  userId: string,
  origin: string,
  recordingIds: ReadonlySet<string>,
  complete: boolean,
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
          const id = yield* uuidV5(`library_item:${userId}:recording:${entityId}:${origin}`);
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

/** Adds or renames a playlist that `origin` imports. Returns whether the row changed. */
export const mirrorPlaylist = (ownerId: string, origin: string, id: string, name: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;

    const [row] = yield* db.select().from(playlist).where(eq(playlist.id, id));
    if (row !== undefined && !row.deleted && row.name === name) return false;

    const change = {
      name,
      hlc: yield* clock.next,
      deleted: false,
      changeSeq: yield* nextChangeSeq,
    };
    yield* db
      .insert(playlist)
      .values({ id, ownerId, origin, createdAt: yield* Clock.currentTimeMillis, ...change })
      .onConflictDoUpdate({ target: playlist.id, set: change });
    return true;
  });

/**
 * Entry IDs come from the recording and its occurrence, so a reorder changes only positions. The
 * first keys of `generateNKeysBetween` do not depend on the count, so appended entries keep them.
 */
export const replaceEntries = (playlistId: string, recordingIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const now = yield* Clock.currentTimeMillis;

    const rows = yield* db
      .select()
      .from(playlistEntry)
      .where(eq(playlistEntry.playlistId, playlistId));
    const known = new Map(rows.map((row) => [row.id, row]));

    const occurrences = new Map<string, number>();
    const positions = generateNKeysBetween(null, null, recordingIds.length);
    const entries = yield* Effect.forEach(
      Arr.zip(recordingIds, positions),
      ([recordingId, position]) => {
        const occurrence = (occurrences.get(recordingId) ?? 0) + 1;
        occurrences.set(recordingId, occurrence);

        return uuidV5(`playlist_entry:${playlistId}:${recordingId}:${occurrence}`).pipe(
          Effect.map((id) => ({ id, recordingId, position })),
        );
      },
    );

    const changed = entries.filter((entry) => {
      const row = known.get(entry.id);
      return row === undefined || row.deleted || row.position !== entry.position;
    });
    const kept = new Set(entries.map((entry) => entry.id));
    const removed = rows.filter((row) => !row.deleted && !kept.has(row.id));
    if (changed.length === 0 && removed.length === 0) return 0;

    const changeSeq = yield* nextChangeSeq;
    yield* Effect.forEach(
      changed,
      (entry) =>
        Effect.gen(function* () {
          const hlc = yield* clock.next;
          if (known.get(entry.id)?.deleted === false) {
            return yield* db
              .update(playlistEntry)
              .set({ position: entry.position, hlc, changeSeq })
              .where(eq(playlistEntry.id, entry.id));
          }

          const row = { ...entry, playlistId, addedAt: now, hlc, deleted: false, changeSeq };
          yield* db
            .insert(playlistEntry)
            .values(row)
            .onConflictDoUpdate({ target: playlistEntry.id, set: row });
        }),
      { discard: true },
    );

    if (removed.length > 0) {
      yield* db
        .update(playlistEntry)
        .set({ deleted: true, hlc: yield* clock.next, changeSeq })
        .where(
          inArray(
            playlistEntry.id,
            removed.map((row) => row.id),
          ),
        );
    }

    return changed.length + removed.length;
  });

export const removePlaylists = (ownerId: string, origin: string, keep: ReadonlySet<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;

    const rows = yield* db
      .select({ id: playlist.id })
      .from(playlist)
      .where(
        and(
          eq(playlist.ownerId, ownerId),
          eq(playlist.origin, origin),
          eq(playlist.deleted, false),
        ),
      );
    const removed = rows.map((row) => row.id).filter((id) => !keep.has(id));
    if (removed.length === 0) return 0;

    const change = { deleted: true, hlc: yield* clock.next, changeSeq: yield* nextChangeSeq };
    yield* db.update(playlist).set(change).where(inArray(playlist.id, removed));
    yield* db
      .update(playlistEntry)
      .set(change)
      .where(and(inArray(playlistEntry.playlistId, removed), eq(playlistEntry.deleted, false)));
    return removed.length;
  });

export const removeOrigin = (userId: string, origin: string) =>
  Effect.gen(function* () {
    yield* setMembership(userId, origin, new Set(), true);
    yield* removePlaylists(userId, origin, new Set());
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
    });
  });

export const listLibrary = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;

  const items = yield* db
    .select({ entityId: libraryItem.entityId, addedAt: libraryItem.addedAt })
    .from(libraryItem)
    .where(and(eq(libraryItem.userId, principal.userId), eq(libraryItem.deleted, false)));
  const view = yield* loadLibraryView(
    principal.userId,
    items.map((item) => item.entityId),
  );
  return view.libraryEntries(items);
});

export const listPlaylists = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;

  const rows = yield* db
    .select({ playlist, entryCount: count(playlistEntry.id) })
    .from(playlist)
    .leftJoin(
      playlistEntry,
      and(eq(playlistEntry.playlistId, playlist.id), eq(playlistEntry.deleted, false)),
    )
    .where(and(eq(playlist.ownerId, principal.userId), eq(playlist.deleted, false)))
    .groupBy(playlist.id);

  return rows
    .map(
      (row) =>
        new PlaylistSummary({
          id: row.playlist.id,
          name: row.playlist.name,
          provider: row.playlist.origin?.startsWith(accountPrefix)
            ? row.playlist.origin.slice(accountPrefix.length)
            : null,
          entryCount: row.entryCount,
          readOnly: row.playlist.origin !== null,
        }),
    )
    .toSorted((a, b) => a.name.localeCompare(b.name));
});

export const listPlaylistEntries = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const principal = yield* CurrentPrincipal;

    const [owned] = yield* db
      .select({ id: playlist.id })
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
    return view.playlistEntries(entries);
  });
