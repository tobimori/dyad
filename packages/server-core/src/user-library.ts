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
  LibraryEntry,
  PlaylistEntry,
  PlaylistNotFound,
  PlaylistSummary,
  RecordingId,
} from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { HlcClock } from "@dyad/sync";
import { and, asc, count, eq, inArray, or } from "drizzle-orm";
import { Array as Arr, Clock, Effect } from "effect";
import { generateNKeysBetween } from "fractional-indexing";

import { uuidV5 } from "./ids.ts";
import { playableSources, sourceSummary } from "./sources.ts";

const accountPrefix = "account:";

export const accountOrigin = (provider: string) => `${accountPrefix}${provider}`;

/**
 * All writes of library items and playlists go through this module, so that a later operation log
 * has one place. With `complete`, the other items of `origin` are removed.
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
    yield* Effect.forEach(
      added,
      (entityId) =>
        Effect.gen(function* () {
          const id = yield* uuidV5(`library_item:${userId}:recording:${entityId}:${origin}`);
          const change = { addedAt: now, hlc: yield* clock.next, deleted: false };

          yield* db
            .insert(libraryItem)
            .values({ id, userId, entityType: "recording", entityId, origin, ...change })
            .onConflictDoUpdate({ target: libraryItem.id, set: change });
        }),
      { discard: true },
    );

    const removed = complete
      ? rows.filter((row) => !row.deleted && !recordingIds.has(row.entityId))
      : [];
    if (removed.length > 0) {
      const ids = removed.map((row) => row.id);
      yield* db
        .update(libraryItem)
        .set({ deleted: true, hlc: yield* clock.next })
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

    const change = { name, hlc: yield* clock.next, deleted: false };
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
    yield* Effect.forEach(
      changed,
      (entry) =>
        Effect.gen(function* () {
          const hlc = yield* clock.next;
          if (known.get(entry.id)?.deleted === false) {
            return yield* db
              .update(playlistEntry)
              .set({ position: entry.position, hlc })
              .where(eq(playlistEntry.id, entry.id));
          }

          const row = { ...entry, playlistId, addedAt: now, hlc, deleted: false };
          yield* db
            .insert(playlistEntry)
            .values(row)
            .onConflictDoUpdate({ target: playlistEntry.id, set: row });
        }),
      { discard: true },
    );

    const kept = new Set(entries.map((entry) => entry.id));
    const removed = rows.filter((row) => !row.deleted && !kept.has(row.id));
    if (removed.length > 0) {
      yield* db
        .update(playlistEntry)
        .set({ deleted: true, hlc: yield* clock.next })
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

    const hlc = yield* clock.next;
    yield* db.update(playlist).set({ deleted: true, hlc }).where(inArray(playlist.id, removed));
    yield* db
      .update(playlistEntry)
      .set({ deleted: true, hlc })
      .where(and(inArray(playlistEntry.playlistId, removed), eq(playlistEntry.deleted, false)));
    return removed.length;
  });

export const removeOrigin = (userId: string, origin: string) =>
  Effect.gen(function* () {
    yield* setMembership(userId, origin, new Set(), true);
    yield* removePlaylists(userId, origin, new Set());
  });

// The canonical recording is `coalesce(merged_into_id, id)`. A bound recording without a row is its
// own root.
const resolveRecordings = (userId: UserId, boundIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;

    const bound = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, boundIds));
    const rootOf = new Map(boundIds.map((id) => [id, id]));
    for (const row of bound) rootOf.set(row.id, row.mergedIntoId ?? row.id);

    // Other recordings in the same groups can bring sources that the user did not save
    const roots = [...new Set(rootOf.values())];
    const members = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(or(inArray(recording.id, roots), inArray(recording.mergedIntoId, roots)));
    const groupOf = new Map(rootOf);
    for (const row of members) groupOf.set(row.id, row.mergedIntoId ?? row.id);

    const sources = yield* playableSources(
      userId,
      inArray(source.recordingId, [...groupOf.keys()]),
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

    // Local files first, then lossless sources
    const sourcesByRoot = new Map<string, Array<(typeof sources)[number]>>();
    const ranked = sources.toSorted(
      (a, b) =>
        Number(b.source.provider === "local") - Number(a.source.provider === "local") ||
        Number(b.variant.lossless) - Number(a.variant.lossless),
    );
    for (const row of ranked) {
      const root = groupOf.get(row.source.recordingId ?? "");
      if (root === undefined) continue;

      const group = sourcesByRoot.get(root) ?? [];
      group.push(row);
      sourcesByRoot.set(root, group);
    }

    const remoteByRoot = new Map(
      remoteTracks.map((row) => [rootOf.get(row.recordingId) ?? row.recordingId, row]),
    );

    // Without the provider's library data, the likely reason is a provider that the user did not link
    const unavailableReason = (remote: typeof libraryRemoteTrack.$inferSelect | undefined) => {
      if (remote === undefined || remote.sourceId !== null) return "account_required" as const;
      return remote.catalogId === null ? ("library_only" as const) : ("not_in_catalog" as const);
    };

    const describe = (root: string) => {
      const candidates = sourcesByRoot.get(root) ?? [];
      const best = candidates[0];
      const remote = remoteByRoot.get(root);

      return {
        recordingId: RecordingId.make(root),
        title: best?.source.rawTitle ?? remote?.rawTitle ?? null,
        artist: best?.source.rawArtist ?? remote?.rawArtist ?? null,
        album: best?.source.rawAlbum ?? remote?.rawAlbum ?? null,
        durationMs: best?.source.rawDurationMs ?? remote?.rawDurationMs ?? null,
        artworkUrl: best?.artworkUrl ?? null,
        source: best === undefined ? null : sourceSummary(best),
        sourceCount: candidates.length,
        unavailable: best === undefined ? unavailableReason(remote) : null,
      };
    };

    return { rootOf, describe };
  });

export const listLibrary = Effect.gen(function* () {
  const db = yield* Database;
  const principal = yield* CurrentPrincipal;

  const items = yield* db
    .select({ entityId: libraryItem.entityId, addedAt: libraryItem.addedAt })
    .from(libraryItem)
    .where(and(eq(libraryItem.userId, principal.userId), eq(libraryItem.deleted, false)));
  const { rootOf, describe } = yield* resolveRecordings(
    principal.userId,
    items.map((item) => item.entityId),
  );

  // An item from several origins, or two saved versions of one recording, gives one entry
  const addedAtByRoot = new Map<string, number>();
  for (const item of items) {
    const root = rootOf.get(item.entityId) ?? item.entityId;
    addedAtByRoot.set(root, Math.min(addedAtByRoot.get(root) ?? item.addedAt, item.addedAt));
  }

  return [...addedAtByRoot]
    .map(([root, addedAt]) => new LibraryEntry({ ...describe(root), addedAt }))
    .toSorted(
      (a, b) =>
        (a.artist ?? "").localeCompare(b.artist ?? "") ||
        (a.album ?? "").localeCompare(b.album ?? "") ||
        (a.title ?? "").localeCompare(b.title ?? ""),
    );
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
    const { rootOf, describe } = yield* resolveRecordings(
      principal.userId,
      entries.map((entry) => entry.recordingId),
    );

    return entries.map(
      (entry) =>
        new PlaylistEntry({
          ...describe(rootOf.get(entry.recordingId) ?? entry.recordingId),
          addedAt: entry.addedAt,
          entryId: entry.id,
        }),
    );
  });
