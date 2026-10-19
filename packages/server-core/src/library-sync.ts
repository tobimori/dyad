import {
  credential,
  job,
  libraryItem,
  libraryRemotePlaylist,
  libraryRemoteTrack,
  librarySyncState,
  playlistEntry,
  providerItem,
  providerAccount,
  recording,
  source,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import { LibrarySyncStatus, PlaylistLink, PlaylistLinkState, accountOrigin } from "@dyad/domain";
import type { PlaylistRow } from "@dyad/domain";
import { LibraryError, ProviderPlaylists } from "@dyad/plugin";
import type {
  Credentials,
  LibraryProbe,
  LibrarySnapshot,
  LibrarySong,
  ProviderLibrary,
} from "@dyad/plugin";
import { and, asc, count, eq, inArray, isNull, notInArray, sql } from "drizzle-orm";
import { HlcClock } from "@dyad/sync";
import { Clock, Data, Effect, Equal, Layer, Option, Schema } from "effect";

import { queueEditions } from "./albums.ts";
import { boundRecordingId, uuidV5 } from "./ids.ts";
import { Jobs, RetryLater } from "./jobs.ts";
import { PlaylistPushPayload, playlistPushKind, queuePlaylistPush } from "./playlist-push.ts";
import { cacheProviderSources } from "./provider-cache.ts";
import { Providers, toCredentials } from "./providers.ts";
import { writeProviderSource } from "./sources.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";
import { readRow } from "./replication.ts";
import {
  addLinkedPlaylist,
  mergeRemoteEntries,
  patchPlaylist,
  rootsOf,
  setMembership,
  unlinkPlaylists,
} from "./user-library.ts";

const jobKind = "provider.library";
const runIntervalMs = 30 * 60 * 1000;
// The probe sees added and removed songs, but not songs that left the catalog or changed metadata
const fullReadIntervalMs = 24 * 60 * 60 * 1000;
const throttleBaseSeconds = 15 * 60;
const throttleLimitSeconds = 6 * 60 * 60;

const SyncPayload = Schema.Struct({ provider: Schema.String });

// A new link queues its own run
class AccountChanged extends Data.TaggedError("AccountChanged")<{}> {}

class LinkedAccount extends Data.Class<{
  readonly id: string;
  // Changes with each link, so that a read can tell a new link of the same provider
  readonly hlc: string;
  readonly provider: string;
  readonly credentials: Credentials;
}> {}

const loadAccount = Effect.fnUntraced(function* (provider: string) {
  const db = yield* Database;
  const [row] = yield* db
    .select({ id: providerAccount.id, hlc: providerAccount.hlc, values: credential.values })
    .from(providerAccount)
    .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id))
    .where(eq(providerAccount.provider, provider));
  if (row === undefined) return Option.none();

  return Option.some(
    new LinkedAccount({
      id: row.id,
      hlc: row.hlc,
      provider,
      credentials: toCredentials(row.values),
    }),
  );
});

// A read takes up to a minute. An unlink or a new link during the read must not bring back the
// library of the old link.
const writeIfLinked = Effect.fnUntraced(function* <A, E, R>(
  account: LinkedAccount,
  write: Effect.Effect<A, E, R>,
) {
  const db = yield* Database;

  return yield* db.transaction(() =>
    Effect.gen(function* () {
      const [current] = yield* db
        .select({ hlc: providerAccount.hlc })
        .from(providerAccount)
        .where(eq(providerAccount.provider, account.provider));
      if (current?.hlc !== account.hlc) return yield* new AccountChanged();

      return yield* write;
    }),
  );
});

const writeState = Effect.fnUntraced(function* (
  account: LinkedAccount,
  values: Omit<typeof librarySyncState.$inferInsert, "provider">,
) {
  const db = yield* Database;
  yield* db
    .insert(librarySyncState)
    .values({ provider: account.provider, ...values })
    .onConflictDoUpdate({
      target: librarySyncState.provider,
      set: values,
    });
});

const writeRemotePlaylist = Effect.fnUntraced(function* (
  account: LinkedAccount,
  remoteId: string,
  values: Omit<typeof libraryRemotePlaylist.$inferInsert, "provider" | "remoteId">,
) {
  const db = yield* Database;
  yield* db
    .insert(libraryRemotePlaylist)
    .values({ provider: account.provider, remoteId, ...values })
    .onConflictDoUpdate({
      target: [libraryRemotePlaylist.provider, libraryRemotePlaylist.remoteId],
      set: values,
    });
});

const writeSongs = Effect.fnUntraced(function* (
  account: LinkedAccount,
  songs: ReadonlyArray<LibrarySong>,
) {
  const db = yield* Database;
  const provider = account.provider;
  const known = new Map(
    (yield* db
      .select()
      .from(libraryRemoteTrack)
      .where(eq(libraryRemoteTrack.provider, provider))).map((row) => [row.recordingId, row]),
  );
  const clock = yield* HlcClock;
  const changed: Array<string> = [];

  const recordingIds = yield* Effect.forEach(songs, (song) =>
    Effect.gen(function* () {
      const sourceId =
        song.source === null ? null : yield* writeProviderSource(provider, song.source);
      // `writeSource` binds the source to the same recording
      const externalId = song.source?.externalId ?? song.catalogId ?? song.remoteId;
      const recordingId = yield* boundRecordingId(provider, externalId);
      // Clients load catalog data by recording, also for songs without a source
      if (sourceId === null) {
        yield* db
          .insert(recording)
          .values({ id: recordingId, origin: "provider", policyVersion: 1, revision: 0 })
          .onConflictDoNothing();
      }

      const row = {
        provider,
        recordingId,
        remoteId: song.remoteId,
        catalogId: song.catalogId,
        sourceId,
        rawTitle: song.title,
        rawArtist: song.artist,
        rawAlbum: song.album,
        rawDurationMs: song.durationMs,
      };
      const old = known.get(recordingId);
      const isChanged =
        old === undefined ||
        old.deleted ||
        old.remoteId !== row.remoteId ||
        old.catalogId !== row.catalogId ||
        old.sourceId !== row.sourceId ||
        old.rawTitle !== row.rawTitle ||
        old.rawArtist !== row.rawArtist ||
        old.rawAlbum !== row.rawAlbum ||
        old.rawDurationMs !== row.rawDurationMs;
      if (!isChanged) return recordingId;

      changed.push(recordingId);
      const version = { deleted: false, hlc: yield* clock.next, changeSeq: yield* nextChangeSeq };
      yield* db
        .insert(libraryRemoteTrack)
        .values({ id: `${provider}:${recordingId}`, ...row, ...version })
        .onConflictDoUpdate({
          target: [libraryRemoteTrack.provider, libraryRemoteTrack.recordingId],
          set: { ...row, ...version },
        });
      return recordingId;
    }),
  );

  // `source` has no artwork and no ISRC. Cache rows of sources in `source` do not expire.
  const sources = songs.flatMap((song) => (song.source === null ? [] : [song.source]));
  yield* cacheProviderSources(provider, sources);
  yield* touchGroups(changed);

  return recordingIds;
});

const incompleteReasonOf = (
  snapshot: LibrarySnapshot<LibrarySong>,
  before: LibraryProbe,
  after: LibraryProbe,
) => {
  if (snapshot.incompleteReason !== null) return snapshot.incompleteReason;
  if (before.version !== after.version) return "the library changed during the read";

  // The total counts each library song once, also songs that the user cannot play
  const distinct = new Set(snapshot.items.map((song) => song.remoteId)).size;
  if (before.total !== null && distinct !== before.total) {
    return `read ${distinct} of ${before.total} songs`;
  }
  return null;
};

const importSongs = Effect.fnUntraced(function* (
  account: LinkedAccount,
  library: ProviderLibrary,
  before: LibraryProbe,
) {
  const snapshot = yield* library.songs(account.credentials);
  const after = yield* library.probe(account.credentials);
  const incompleteReason = incompleteReasonOf(snapshot, before, after);
  const complete = incompleteReason === null;
  const now = yield* Clock.currentTimeMillis;

  const membership = yield* writeIfLinked(
    account,
    Effect.gen(function* () {
      const recordingIds = yield* writeSongs(account, snapshot.items);
      const changes = yield* setMembership(
        accountOrigin(account.provider),
        new Set(recordingIds),
        complete,
      );

      yield* writeState(account, { lastFullReadAt: now, incompleteReason });
      if (complete) {
        yield* writeState(account, { songsVersion: before.version, lastCompleteAt: now });
      }
      return changes;
    }),
  );

  yield* Effect.logInfo("Library songs imported").pipe(
    Effect.annotateLogs({
      provider: account.provider,
      songs: snapshot.items.length,
      total: before.total,
      incompleteReason,
      ...membership,
    }),
  );
});

const remotePlaylistOf = (account: LinkedAccount, remoteId: string) =>
  and(
    eq(libraryRemotePlaylist.provider, account.provider),
    eq(libraryRemotePlaylist.remoteId, remoteId),
  );

/**
 * Applies the provider's changes since the last sync to the entries. An incomplete read changes no
 * entries, because a part of an ordered list has no order. Returns the provider's songs as bound
 * recordings, or `None` after an incomplete read.
 */
const pullPlaylist = Effect.fnUntraced(function* (
  account: LinkedAccount,
  library: ProviderLibrary,
  link: {
    readonly playlistId: string;
    readonly remoteId: string;
    readonly version: string | null;
  },
) {
  const db = yield* Database;
  const now = yield* Clock.currentTimeMillis;
  const { playlistId, remoteId } = link;
  const songs = yield* library.playlistSongs(account.credentials, remoteId);

  const pulled = yield* writeIfLinked(
    account,
    Effect.gen(function* () {
      const incompleteReason = songs.incompleteReason;
      if (incompleteReason !== null) {
        yield* writeRemotePlaylist(account, remoteId, { playlistId, incompleteReason });
        return Option.none();
      }

      const [current] = yield* db
        .select({ snapshot: libraryRemotePlaylist.snapshot })
        .from(libraryRemotePlaylist)
        .where(remotePlaylistOf(account, remoteId));
      const recordingIds = yield* writeSongs(account, songs.items);
      const changed = yield* mergeRemoteEntries(
        playlistId,
        current?.snapshot ?? null,
        recordingIds,
      );
      yield* writeRemotePlaylist(account, remoteId, {
        playlistId,
        incompleteReason,
        version: link.version,
        lastCompleteAt: now,
        snapshot: recordingIds,
      });
      return Option.some({ recordingIds, changed });
    }),
  );

  yield* Effect.logInfo("Library playlist imported").pipe(
    Effect.annotateLogs({
      provider: account.provider,
      songs: songs.items.length,
      incompleteReason: songs.incompleteReason,
      changedEntries: Option.match(pulled, { onNone: () => 0, onSome: (value) => value.changed }),
    }),
  );
  return pulled;
});

/**
 * Each remote playlist has a Dyad playlist with a link to it. A read applies only the provider's
 * changes since the last sync, so that the edits in Dyad stay. A removed remote playlist unlinks
 * its playlist.
 */
const importPlaylists = Effect.fnUntraced(function* (
  account: LinkedAccount,
  library: ProviderLibrary,
) {
  const db = yield* Database;
  const list = yield* library.playlists(account.credentials);

  const known = new Map(
    (yield* db
      .select()
      .from(libraryRemotePlaylist)
      .where(eq(libraryRemotePlaylist.provider, account.provider))).map((row) => [
      row.remoteId,
      row,
    ]),
  );

  yield* Effect.forEach(
    list.items,
    (remote) =>
      Effect.gen(function* () {
        const state = known.get(remote.remoteId);
        const playlistId =
          state?.playlistId ?? (yield* uuidV5(`playlist:${account.provider}:${remote.remoteId}`));
        const now = yield* Clock.currentTimeMillis;
        const link = new PlaylistLink({
          provider: account.provider,
          remoteId: remote.remoteId,
          direction: "import",
        });

        // A playlist that the user unlinked or deleted stays as it is. After a new link of the
        // account, the provider's state is the base, so that nothing is added twice.
        const next = yield* writeIfLinked(
          account,
          Effect.gen(function* () {
            const row = yield* readRow("playlist", playlistId);
            if (row === undefined) {
              yield* addLinkedPlaylist(
                playlistId,
                remote.name,
                accountOrigin(account.provider),
                link,
              );
              yield* writeRemotePlaylist(account, remote.remoteId, {
                playlistId,
                snapshot: [],
                name: remote.name,
              });
              return "pull";
            }
            if (row.table !== "playlist" || row.deleted) return "skip";
            if (row.link === null && state === undefined) {
              yield* patchPlaylist(playlistId, { link });
              yield* writeRemotePlaylist(account, remote.remoteId, {
                playlistId,
                snapshot: null,
                name: remote.name,
              });
              return "pull";
            }
            if (row.link?.provider !== link.provider || row.link.remoteId !== link.remoteId) {
              return "skip";
            }

            if (state?.name !== remote.name) {
              yield* patchPlaylist(playlistId, { name: remote.name });
              yield* writeRemotePlaylist(account, remote.remoteId, {
                playlistId,
                name: remote.name,
              });
            }
            return row.link.direction === "two-way" ? "push" : "pull";
          }),
        );

        // The push reads the songs before it writes
        if (next === "push") return yield* queuePlaylistPush(playlistId);
        const readDue =
          next === "pull" &&
          (remote.version === null ||
            state?.version !== remote.version ||
            state.lastCompleteAt === null ||
            now - state.lastCompleteAt >= fullReadIntervalMs);
        if (readDue) {
          yield* pullPlaylist(account, library, {
            playlistId,
            remoteId: remote.remoteId,
            version: remote.version,
          });
        }
      }),
    { discard: true },
  );

  if (list.incompleteReason !== null) return;

  yield* writeIfLinked(
    account,
    Effect.gen(function* () {
      const remoteIds = list.items.map((remote) => remote.remoteId);
      const unlinked = yield* unlinkPlaylists(account.provider, new Set(remoteIds));
      yield* db
        .delete(libraryRemotePlaylist)
        .where(
          and(
            eq(libraryRemotePlaylist.provider, account.provider),
            notInArray(libraryRemotePlaylist.remoteId, remoteIds),
          ),
        );

      if (unlinked.length > 0) {
        yield* Effect.logInfo("Library playlists unlinked").pipe(
          Effect.annotateLogs({ provider: account.provider, unlinked: unlinked.length }),
        );
      }
    }),
  );
});

// Removes from `list` one item for each item of `other`, by key
const withoutEach = <A>(
  list: ReadonlyArray<A>,
  other: ReadonlyArray<string>,
  key: (a: A) => string,
) => {
  const counts = new Map<string, number>();
  for (const item of other) counts.set(item, (counts.get(item) ?? 0) + 1);
  return list.filter((item) => {
    const count = counts.get(key(item)) ?? 0;
    counts.set(key(item), count - 1);
    return count <= 0;
  });
};

/**
 * Reads the provider playlist, then sends the new songs in Dyad with `add`. Entries without a
 * source of the provider stay only in Dyad.
 */
const pushPlaylist = Effect.fnUntraced(function* (
  account: LinkedAccount,
  library: ProviderLibrary,
  writes: ProviderPlaylists,
  providerName: string,
  row: PlaylistRow,
) {
  const db = yield* Database;
  const playlistId = row.id;
  const link = row.link;
  if (link === null) return;

  const remoteId =
    link.remoteId ??
    (writes.create === undefined ? null : yield* writes.create(account.credentials, row.name));
  if (remoteId === null) {
    return yield* patchPlaylist(playlistId, {
      linkState: new PlaylistLinkState({
        differs: true,
        error: `${providerName} cannot create playlists`,
      }),
    });
  }
  if (link.remoteId === null) {
    // An unlink during the create keeps the new provider playlist out of Dyad
    const kept = yield* writeIfLinked(
      account,
      Effect.gen(function* () {
        const current = yield* readRow("playlist", playlistId);
        if (current?.table !== "playlist" || !Equal.equals(current.link, link)) return false;
        yield* patchPlaylist(playlistId, { link: new PlaylistLink({ ...link, remoteId }) });
        yield* writeRemotePlaylist(account, remoteId, {
          playlistId,
          snapshot: [],
          name: row.name,
        });
        return true;
      }),
    );
    if (!kept) return;
  }

  // A two-way link reads the songs at each push, so it needs no version
  const pulled = yield* pullPlaylist(account, library, { playlistId, remoteId, version: null });
  if (Option.isNone(pulled)) {
    return yield* new LibraryError({
      kind: "failed",
      reason: "The provider gave a part of the playlist",
      retryAfterSeconds: null,
    });
  }
  const remote = pulled.value.recordingIds;

  const entries = yield* db
    .select({ recordingId: playlistEntry.recordingId })
    .from(playlistEntry)
    .where(and(eq(playlistEntry.playlistId, playlistId), eq(playlistEntry.deleted, false)))
    .orderBy(asc(playlistEntry.position), asc(playlistEntry.id));
  const rootOf = yield* rootsOf([...entries.map((entry) => entry.recordingId), ...remote]);
  // A source of any recording of the group plays the entry
  const root = sql<string>`coalesce(${recording.mergedIntoId}, ${recording.id})`;
  const sources = yield* db
    .select({ externalId: source.externalId, recordingId: recording.id, root })
    .from(source)
    .innerJoin(recording, eq(recording.id, source.recordingId))
    .where(
      and(
        eq(source.provider, account.provider),
        eq(source.availability, "available"),
        inArray(
          root,
          entries.map((entry) => rootOf(entry.recordingId)),
        ),
      ),
    )
    .orderBy(asc(source.id));
  const songOf = new Map(sources.toReversed().map((found) => [found.root, found]));

  const wanted = entries.flatMap((entry) => songOf.get(rootOf(entry.recordingId)) ?? []);
  const sameOrder = (recordingIds: ReadonlyArray<string>) =>
    recordingIds.length === wanted.length &&
    recordingIds.every((id, index) => rootOf(id) === wanted[index]?.root);

  const written = yield* Effect.gen(function* () {
    if (sameOrder(remote)) return remote;
    const added = withoutEach(wanted, remote.map(rootOf), (song) => song.root);
    if (writes.add === undefined || added.length === 0) return remote;
    yield* writes.add(
      account.credentials,
      remoteId,
      added.map((song) => song.externalId),
    );
    return [...remote, ...added.map((song) => song.recordingId)];
  });

  yield* writeIfLinked(
    account,
    Effect.gen(function* () {
      yield* writeRemotePlaylist(account, remoteId, { playlistId, snapshot: written });
      yield* patchPlaylist(playlistId, {
        linkState: new PlaylistLinkState({ differs: !sameOrder(written), error: null }),
      });
    }),
  );
  yield* Effect.logInfo("Playlist sent to the provider").pipe(
    Effect.annotateLogs({
      provider: account.provider,
      songs: written.length,
      added: written.length - remote.length,
      differs: !sameOrder(written),
    }),
  );
});

const runPlaylistPush = Effect.fnUntraced(
  function* (payload: typeof PlaylistPushPayload.Type) {
    const providers = yield* Providers;
    const row = yield* readRow("playlist", payload.playlistId);
    if (row?.table !== "playlist" || row.deleted || row.link?.direction !== "two-way") return;

    const providerId = row.link.provider;
    const provider = providers.get(providerId);
    // The plugins unload before the jobs stop, so the queue tries again later
    if (provider?.library === undefined) {
      return yield* new LibraryError({
        kind: "failed",
        reason: "The provider has no library",
        retryAfterSeconds: null,
      });
    }
    const setError = (error: string) =>
      patchPlaylist(row.id, { linkState: new PlaylistLinkState({ differs: true, error }) });

    const account = yield* loadAccount(providerId);
    if (Option.isNone(account)) {
      yield* setError(`Link the ${provider.name} account to send the changes`);
      return;
    }

    yield* pushPlaylist(
      account.value,
      provider.library,
      provider.playlists ?? new ProviderPlaylists({}),
      provider.name,
      row,
    ).pipe(
      Effect.catchTag("LibraryError", (error) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("Playlist write failed").pipe(
            Effect.annotateLogs({ provider: providerId, kind: error.kind, reason: error.reason }),
          );
          yield* setError(error.reason);
          if (error.kind === "account") return;
          if (error.kind === "failed") return yield* error;
          return yield* new RetryLater({
            retryAfterSeconds: error.retryAfterSeconds ?? throttleBaseSeconds,
          });
        }),
      ),
    );
  },
  Effect.catchTag("AccountChanged", () => Effect.void),
);

const importLibrary = Effect.fnUntraced(function* (
  account: LinkedAccount,
  library: ProviderLibrary,
) {
  const db = yield* Database;
  const jobs = yield* Jobs;
  const startedAt = yield* Clock.currentTimeMillis;

  yield* writeIfLinked(account, writeState(account, { lastAttemptAt: startedAt }));
  const [state] = yield* db
    .select()
    .from(librarySyncState)
    .where(eq(librarySyncState.provider, account.provider));

  const probe = yield* library.probe(account.credentials);
  const lastFullReadAt = state?.lastFullReadAt ?? null;
  const songsDue =
    probe.version !== state?.songsVersion ||
    lastFullReadAt === null ||
    startedAt - lastFullReadAt >= fullReadIntervalMs;
  if (songsDue) yield* importSongs(account, library, probe);

  yield* importPlaylists(account, library);

  const finishedAt = yield* Clock.currentTimeMillis;
  yield* writeIfLinked(
    account,
    Effect.gen(function* () {
      yield* writeState(account, { status: "ok", error: null, throttleCount: 0 });
      yield* jobs.enqueue(
        jobKind,
        account.provider,
        { provider: account.provider },
        { runAt: finishedAt + runIntervalMs },
      );
    }),
  );
});

// `account` stops the runs until a new link. `failed` uses the backoff of the queue.
const recordFailure = Effect.fnUntraced(function* (account: LinkedAccount, error: LibraryError) {
  const db = yield* Database;
  yield* Effect.logWarning("Library import failed").pipe(
    Effect.annotateLogs({ provider: account.provider, kind: error.kind, reason: error.reason }),
  );

  if (error.kind === "account") {
    return yield* writeIfLinked(
      account,
      writeState(account, { status: "needs_relink", error: error.reason }),
    );
  }

  if (error.kind === "failed") {
    yield* writeIfLinked(account, writeState(account, { status: "error", error: error.reason }));
    return yield* error;
  }

  const [state] = yield* db
    .select({ throttleCount: librarySyncState.throttleCount })
    .from(librarySyncState)
    .where(eq(librarySyncState.provider, account.provider));
  const throttleCount = (state?.throttleCount ?? 0) + 1;
  yield* writeIfLinked(
    account,
    writeState(account, { status: "throttled", error: error.reason, throttleCount }),
  );

  const backoffSeconds = throttleBaseSeconds * 2 ** (throttleCount - 1);
  return yield* new RetryLater({
    retryAfterSeconds: Math.min(
      Math.max(error.retryAfterSeconds ?? 0, backoffSeconds),
      throttleLimitSeconds,
    ),
  });
});

const runLibrarySync = Effect.fnUntraced(
  function* (payload: typeof SyncPayload.Type) {
    const providers = yield* Providers;

    const account = yield* loadAccount(payload.provider);
    if (Option.isNone(account)) return;

    const library = providers.get(payload.provider)?.library;
    if (library === undefined) {
      return yield* writeIfLinked(
        account.value,
        writeState(account.value, { status: "error", error: "The provider has no library" }),
      );
    }

    yield* importLibrary(account.value, library).pipe(
      Effect.catchTag("LibraryError", (error) => recordFailure(account.value, error)),
    );
    yield* queueLibraryEditions(payload.provider);
  },
  Effect.catchTag("AccountChanged", () => Effect.void),
);

// The albums of all library songs, also of songs that this sync did not change
const queueLibraryEditions = Effect.fnUntraced(function* (provider: string) {
  const db = yield* Database;
  const rows = yield* db
    .selectDistinct({
      albumId: sql<string | null>`json_extract(${providerItem.data}, '$.albumId')`,
    })
    .from(libraryRemoteTrack)
    .innerJoin(providerItem, eq(providerItem.sourceId, libraryRemoteTrack.sourceId))
    .where(and(eq(libraryRemoteTrack.provider, provider), eq(libraryRemoteTrack.deleted, false)));
  yield* queueEditions(
    provider,
    rows.flatMap((row) => row.albumId ?? []),
  );
});

export const queueLibrarySync = Effect.fn("queueLibrarySync")(function* (provider: string) {
  const jobs = yield* Jobs;
  const providers = yield* Providers;
  if (providers.get(provider)?.library === undefined) return;

  yield* jobs.enqueue(jobKind, provider, { provider });
});

/**
 * Removes the imported library, its state and its job, and unlinks the playlists, which stay. Run
 * it in the unlink transaction.
 */
export const forgetLibrary = Effect.fn("forgetLibrary")(function* (provider: string) {
  const db = yield* Database;
  const jobs = yield* Jobs;

  yield* setMembership(accountOrigin(provider), new Set(), true);
  yield* unlinkPlaylists(provider, new Set());
  yield* db.delete(librarySyncState).where(eq(librarySyncState.provider, provider));
  const clock = yield* HlcClock;
  const removed = yield* db
    .update(libraryRemoteTrack)
    .set({ deleted: true, hlc: yield* clock.next, changeSeq: yield* nextChangeSeq })
    .where(and(eq(libraryRemoteTrack.provider, provider), eq(libraryRemoteTrack.deleted, false)))
    .returning({ recordingId: libraryRemoteTrack.recordingId });
  yield* touchGroups(removed.map((row) => row.recordingId));
  yield* db.delete(libraryRemotePlaylist).where(eq(libraryRemotePlaylist.provider, provider));
  yield* jobs.cancel(jobKind, provider);
});

export const syncLibrary = Effect.fn("syncLibrary")(function* (provider: string) {
  const account = yield* loadAccount(provider);
  if (Option.isNone(account)) return;

  yield* queueLibrarySync(provider);
});

export const getLibrarySyncStatus = Effect.gen(function* () {
  const db = yield* Database;
  const providers = yield* Providers;

  const accounts = yield* db
    .select({ provider: providerAccount.provider })
    .from(providerAccount)
    .where(eq(providerAccount.deleted, false));
  const linked = accounts.filter(({ provider }) => providers.get(provider)?.library !== undefined);

  return yield* Effect.forEach(linked, ({ provider }) =>
    Effect.gen(function* () {
      const [state] = yield* db
        .select()
        .from(librarySyncState)
        .where(eq(librarySyncState.provider, provider));
      const [run] = yield* db
        .select({ nextRunAt: job.nextRunAt, startedAt: job.startedAt })
        .from(job)
        .where(and(eq(job.kind, jobKind), eq(job.key, provider)));

      const liveItems = and(
        eq(libraryItem.origin, accountOrigin(provider)),
        eq(libraryItem.deleted, false),
      );
      const [items] = yield* db.select({ count: count() }).from(libraryItem).where(liveItems);
      const [notPlayable] = yield* db
        .select({ count: count() })
        .from(libraryItem)
        .innerJoin(
          libraryRemoteTrack,
          and(
            eq(libraryRemoteTrack.provider, provider),
            eq(libraryRemoteTrack.recordingId, libraryItem.entityId),
          ),
        )
        .where(and(liveItems, isNull(libraryRemoteTrack.sourceId)));

      return new LibrarySyncStatus({
        provider,
        status: state?.status ?? "pending",
        running: run !== undefined && run.startedAt !== null,
        lastCompleteAt: state?.lastCompleteAt ?? null,
        lastAttemptAt: state?.lastAttemptAt ?? null,
        nextRunAt: run?.nextRunAt ?? null,
        incompleteReason: state?.incompleteReason ?? null,
        error: state?.error ?? null,
        itemCount: items?.count ?? 0,
        notPlayableCount: notPlayable?.count ?? 0,
      });
    }),
  );
});

/** Build it after the plugins, so that the first runs find their providers */
export const librarySyncLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;

    yield* jobs.register(jobKind, SyncPayload, runLibrarySync);
    yield* jobs.register(playlistPushKind, PlaylistPushPayload, runPlaylistPush);

    const accounts = yield* db
      .select({ provider: providerAccount.provider })
      .from(providerAccount)
      // Only the replica with the credential reads the library
      .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id));
    yield* Effect.forEach(accounts, (account) => queueLibrarySync(account.provider), {
      discard: true,
    });
  }).pipe(Effect.orDie),
);
