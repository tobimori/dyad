import { playlistEntry } from "@dyad/db/client";
import {
  PlaylistCreate,
  PlaylistEntryAdd,
  PlaylistEntryPatch,
  PlaylistEntryRow,
  PlaylistLink,
  PlaylistPatch,
  PlaylistRow,
} from "@dyad/domain";
import type { HybridLogicalClock, RecordingId, SyncChange, UserId } from "@dyad/domain";
import { and, asc, eq } from "drizzle-orm";
import { Clock, Crypto, Effect, Random } from "effect";
import { generateKeyBetween } from "fractional-indexing";

import { ClientDatabase } from "./database.ts";

// A key must not end in `0`
const jitterDigits = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

// Two random characters make equal keys from concurrent inserts at the same place unlikely
const keyBetween = (before: string | null, after: string | null) =>
  Effect.gen(function* () {
    const key = generateKeyBetween(before, after);
    const digit = Effect.map(
      Random.nextIntBetween(0, jitterDigits.length, { halfOpen: true }),
      (index) => jitterDigits[index],
    );
    const jittered = `${key}${yield* digit}${yield* digit}`;
    return after === null || jittered < after ? jittered : key;
  });

const liveEntries = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    return yield* db
      .select({ id: playlistEntry.id, position: playlistEntry.position })
      .from(playlistEntry)
      .where(and(eq(playlistEntry.playlistId, playlistId), eq(playlistEntry.deleted, false)))
      .orderBy(asc(playlistEntry.position), asc(playlistEntry.id));
  }).pipe(Effect.orDie);

const appendEntries = (
  playlistId: string,
  after: string | null,
  entries: ReadonlyArray<{ readonly recordingId: RecordingId; readonly sourceId: string | null }>,
  next: Effect.Effect<HybridLogicalClock>,
) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const addedAt = yield* Clock.currentTimeMillis;
    const changes: Array<SyncChange> = [];
    let last = after;
    for (const entry of entries) {
      last = yield* keyBetween(last, null);
      const row = new PlaylistEntryRow({
        table: "playlist_entry",
        id: yield* crypto.randomUUIDv7(),
        playlistId,
        recordingId: entry.recordingId,
        position: last,
        addedAt,
        hlc: yield* next,
        fieldHlc: null,
        deleted: false,
      });
      changes.push(
        new PlaylistEntryAdd({
          kind: "playlist_entry.add",
          schemaVersion: 1,
          row,
          sourceId: entry.sourceId,
        }),
      );
    }
    return changes;
  }).pipe(Effect.orDie);

/**
 * The changes of the playlist edits. Each edit is one mutation: `mutate` applies it to the replica
 * and queues it for the server.
 */
export const playlistEdits = <E>(
  mutate: <A>(
    build: (
      next: Effect.Effect<HybridLogicalClock>,
    ) => Effect.Effect<
      readonly [A, ReadonlyArray<SyncChange>],
      never,
      ClientDatabase | Crypto.Crypto
    >,
  ) => Effect.Effect<A>,
  owner: Effect.Effect<UserId, E>,
) => {
  const patchPlaylist = (
    id: string,
    fields: { readonly name?: string; readonly link?: null; readonly deleted?: true },
  ) =>
    mutate((next) =>
      Effect.map(next, (hlc) => [
        undefined,
        [new PlaylistPatch({ kind: "playlist.patch", schemaVersion: 1, id, hlc, ...fields })],
      ]),
    );

  const patchEntry = (
    id: string,
    hlc: HybridLogicalClock,
    fields: { readonly position?: string; readonly deleted?: true },
  ) =>
    new PlaylistEntryPatch({ kind: "playlist_entry.patch", schemaVersion: 1, id, hlc, ...fields });

  return {
    /**
     * Returns the ID of the new playlist. With `twoWayProvider`, the server creates a playlist of
     * that provider and sends the edits to it.
     */
    create: (
      name: string,
      entries: ReadonlyArray<{
        readonly recordingId: RecordingId;
        readonly sourceId: string | null;
      }>,
      twoWayProvider: string | null = null,
    ) =>
      Effect.gen(function* () {
        const ownerId = yield* owner;
        return yield* mutate((next) =>
          Effect.gen(function* () {
            const crypto = yield* Crypto.Crypto;
            const row = new PlaylistRow({
              table: "playlist",
              id: yield* crypto.randomUUIDv7().pipe(Effect.orDie),
              ownerId,
              name,
              origin: null,
              link:
                twoWayProvider === null
                  ? null
                  : new PlaylistLink({
                      provider: twoWayProvider,
                      remoteId: null,
                      direction: "two-way",
                    }),
              linkState: null,
              createdAt: yield* Clock.currentTimeMillis,
              hlc: yield* next,
              fieldHlc: null,
              deleted: false,
            });
            const create = new PlaylistCreate({ kind: "playlist.create", schemaVersion: 1, row });
            return [row.id, [create, ...(yield* appendEntries(row.id, null, entries, next))]];
          }),
        );
      }),
    rename: (id: string, name: string) => patchPlaylist(id, { name }),
    delete: (id: string) => patchPlaylist(id, { deleted: true }),
    /** The playlist stays, and the server stops its sync with the provider */
    unlink: (id: string) => patchPlaylist(id, { link: null }),
    /** Adds the recordings at the end. A playlist can have a recording more than once. */
    add: (
      playlistId: string,
      entries: ReadonlyArray<{
        readonly recordingId: RecordingId;
        readonly sourceId: string | null;
      }>,
    ) =>
      mutate((next) =>
        Effect.gen(function* () {
          const last = (yield* liveEntries(playlistId)).at(-1)?.position ?? null;
          return [undefined, yield* appendEntries(playlistId, last, entries, next)];
        }),
      ),
    removeEntry: (entryId: string) =>
      mutate((next) =>
        Effect.map(next, (hlc) => [undefined, [patchEntry(entryId, hlc, { deleted: true })]]),
      ),
    /** Moves the entry one place up or down */
    moveEntry: (playlistId: string, entryId: string, direction: 1 | -1) =>
      mutate((next) =>
        Effect.gen(function* () {
          const entries = yield* liveEntries(playlistId);
          const index = entries.findIndex((entry) => entry.id === entryId);
          const others = entries.filter((entry) => entry.id !== entryId);
          const target = index + direction;
          if (index === -1 || target < 0 || target > others.length) return [undefined, []];

          const before = others[target - 1]?.position ?? null;
          const after = others[target];
          if (after === undefined || before !== after.position) {
            const position = yield* keyBetween(before, after?.position ?? null);
            return [undefined, [patchEntry(entryId, yield* next, { position })]];
          }

          // Equal keys from concurrent inserts: the entry after the place moves up first
          const higher = others.slice(target + 1).find((entry) => entry.position > after.position);
          const moved = yield* keyBetween(after.position, higher?.position ?? null);
          const position = yield* keyBetween(before, moved);
          return [
            undefined,
            [
              patchEntry(after.id, yield* next, { position: moved }),
              patchEntry(entryId, yield* next, { position }),
            ],
          ];
        }),
      ),
  };
};
