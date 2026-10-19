import { playlist, playlistEntry } from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  PlaylistEntryRow,
  PlaylistLink,
  PlaylistNotFound,
  PlaylistRow,
  playlistSummary,
} from "@dyad/domain";
import type { PlaylistEntryInput as EntryInput } from "@dyad/domain";
import { HlcClock, patchRow, wallTimeOf } from "@dyad/sync";
import { and, asc, count, eq } from "drizzle-orm";
import { Crypto, Effect, Option, Random } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import { pushIfHeld } from "./playlist-push.ts";
import { readRow, writeRow } from "./replication.ts";
import { addReferencedSources } from "./sources.ts";
import { nextChangeSeq } from "./sync-counter.ts";
import { patchPlaylist } from "./user-library.ts";

export const listPlaylists = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db
    .select({ playlist, entryCount: count(playlistEntry.id) })
    .from(playlist)
    .leftJoin(
      playlistEntry,
      and(eq(playlistEntry.playlistId, playlist.id), eq(playlistEntry.deleted, false)),
    )
    .where(eq(playlist.deleted, false))
    .groupBy(playlist.id);

  return rows
    .map((row) => playlistSummary(row.playlist, row.entryCount))
    .toSorted((a, b) => a.name.localeCompare(b.name));
});

// A key must not end in `0`
const jitterDigits = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Two random characters make equal keys from inserts on two replicas at the same place unlikely
const keyBetween = Effect.fnUntraced(function* (before: string | null, after: string | null) {
  const key = generateKeyBetween(before, after);
  const digit = Effect.map(
    Random.nextIntBetween(0, jitterDigits.length, { halfOpen: true }),
    (index) => jitterDigits[index],
  );
  const jittered = `${key}${yield* digit}${yield* digit}`;
  return after === null || jittered < after ? jittered : key;
});

const liveEntries = Effect.fnUntraced(function* (playlistId: string) {
  const db = yield* Database;
  return yield* db
    .select({ id: playlistEntry.id, position: playlistEntry.position })
    .from(playlistEntry)
    .where(and(eq(playlistEntry.playlistId, playlistId), eq(playlistEntry.deleted, false)))
    .orderBy(asc(playlistEntry.position), asc(playlistEntry.id));
});

const ownedPlaylist = Effect.fnUntraced(function* (playlistId: string) {
  const row = yield* readRow("playlist", playlistId);
  if (row?.table !== "playlist" || row.deleted) {
    return yield* new PlaylistNotFound();
  }
  return row;
});

const appendEntries = Effect.fnUntraced(function* (
  playlistId: string,
  entries: ReadonlyArray<typeof EntryInput.Type>,
) {
  const db = yield* Database;
  const crypto = yield* Crypto.Crypto;
  const clock = yield* HlcClock;
  yield* addReferencedSources(entries);

  let last = (yield* liveEntries(playlistId)).at(-1)?.position ?? null;
  const rows: Array<PlaylistEntryRow> = [];
  for (const entry of entries) {
    last = yield* keyBetween(last, null);
    const hlc = yield* clock.next;
    rows.push(
      new PlaylistEntryRow({
        table: "playlist_entry",
        id: yield* crypto.randomUUIDv7().pipe(Effect.orDie),
        playlistId,
        recordingId: entry.recordingId,
        position: last,
        addedAt: wallTimeOf(hlc),
        hlc,
        fieldHlc: null,
        deleted: false,
      }),
    );
  }
  yield* db.transaction(() =>
    Effect.gen(function* () {
      const changeSeq = yield* nextChangeSeq;
      yield* Effect.forEach(rows, (row) => writeRow(row, changeSeq), { discard: true });
    }),
  );
});

/** Returns the ID of the new playlist */
export const createPlaylist = Effect.fn("createPlaylist")(function* (
  name: string,
  entries: ReadonlyArray<typeof EntryInput.Type>,
  twoWayProvider: string | null,
) {
  const crypto = yield* Crypto.Crypto;
  const clock = yield* HlcClock;
  const hlc = yield* clock.next;
  const row = new PlaylistRow({
    table: "playlist",
    id: yield* crypto.randomUUIDv7().pipe(Effect.orDie),
    name,
    origin: null,
    link:
      twoWayProvider === null
        ? null
        : new PlaylistLink({ provider: twoWayProvider, remoteId: null, direction: "two-way" }),
    linkState: null,
    createdAt: wallTimeOf(hlc),
    hlc,
    fieldHlc: null,
    deleted: false,
  });
  yield* writeRow(row, yield* nextChangeSeq);
  yield* appendEntries(row.id, entries);
  yield* pushIfHeld(row.id);
  return row.id;
});

export const addPlaylistEntries = Effect.fn("addPlaylistEntries")(function* (
  playlistId: string,
  entries: ReadonlyArray<typeof EntryInput.Type>,
) {
  yield* ownedPlaylist(playlistId);
  yield* appendEntries(playlistId, entries);
  yield* pushIfHeld(playlistId);
});

export const editPlaylist = Effect.fn("editPlaylist")(function* (
  playlistId: string,
  edit: { readonly name?: string; readonly unlink?: true; readonly deleted?: true },
) {
  yield* ownedPlaylist(playlistId);
  yield* patchPlaylist(playlistId, {
    name: edit.name,
    link: edit.unlink === undefined ? undefined : null,
    deleted: edit.deleted,
  });
  yield* pushIfHeld(playlistId);
});

const patchEntry = Effect.fnUntraced(function* (
  id: string,
  fields: { readonly position?: string; readonly deleted?: true },
) {
  const clock = yield* HlcClock;
  const current = yield* readRow("playlist_entry", id);
  if (current?.table !== "playlist_entry") return;
  const next = patchRow(current, fields, yield* clock.next);
  if (Option.isSome(next)) yield* writeRow(next.value, yield* nextChangeSeq);
});

export const removePlaylistEntry = Effect.fn("removePlaylistEntry")(function* (entryId: string) {
  const entry = yield* readRow("playlist_entry", entryId);
  if (entry?.table !== "playlist_entry") return;
  yield* patchEntry(entryId, { deleted: true });
  yield* pushIfHeld(entry.playlistId);
});

export const movePlaylistEntry = Effect.fn("movePlaylistEntry")(function* (
  playlistId: string,
  entryId: string,
  direction: 1 | -1,
) {
  const entries = yield* liveEntries(playlistId);
  const index = entries.findIndex((entry) => entry.id === entryId);
  const others = entries.filter((entry) => entry.id !== entryId);
  const target = index + direction;
  if (index === -1 || target < 0 || target > others.length) return;

  const before = others[target - 1]?.position ?? null;
  const after = others[target];
  if (after === undefined || before !== after.position) {
    yield* patchEntry(entryId, { position: yield* keyBetween(before, after?.position ?? null) });
    return yield* pushIfHeld(playlistId);
  }

  // Equal keys from inserts on two replicas: the entry after the place moves up first
  const higher = others.slice(target + 1).find((entry) => entry.position > after.position);
  const moved = yield* keyBetween(after.position, higher?.position ?? null);
  yield* patchEntry(after.id, { position: moved });
  yield* patchEntry(entryId, { position: yield* keyBetween(before, moved) });
  yield* pushIfHeld(playlistId);
});
