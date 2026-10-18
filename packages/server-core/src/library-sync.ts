import {
  credential,
  job,
  libraryItem,
  libraryRemotePlaylist,
  libraryRemoteTrack,
  librarySyncState,
  providerAccount,
  recording,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, LibrarySyncStatus, UserId } from "@dyad/domain";
import type {
  Credentials,
  LibraryError,
  LibraryProbe,
  LibrarySnapshot,
  LibrarySong,
  ProviderLibrary,
} from "@dyad/plugin";
import { and, count, eq, isNull, notInArray } from "drizzle-orm";
import { Clock, Data, Effect, Layer, Option, Schema } from "effect";

import { boundRecordingId, uuidV5 } from "./ids.ts";
import { Jobs, RetryLater } from "./jobs.ts";
import { cacheProviderSources } from "./provider-cache.ts";
import { Providers, toCredentials } from "./providers.ts";
import { writeProviderSource } from "./sources.ts";
import { touchGroups } from "./sync-counter.ts";
import {
  accountOrigin,
  mirrorPlaylist,
  removeOrigin,
  removePlaylists,
  replaceEntries,
  setMembership,
} from "./user-library.ts";

const jobKind = "provider.library";
const runIntervalMs = 30 * 60 * 1000;
// The probe sees added and removed songs, but not songs that left the catalog or changed metadata
const fullReadIntervalMs = 24 * 60 * 60 * 1000;
const throttleBaseSeconds = 15 * 60;
const throttleLimitSeconds = 6 * 60 * 60;

const SyncPayload = Schema.Struct({ userId: UserId, provider: Schema.String });

const jobKey = (userId: string, provider: string) => `${userId}:${provider}`;

// A new link queues its own run
class AccountChanged extends Data.TaggedError("AccountChanged")<{}> {}

class LinkedAccount extends Data.Class<{
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly credentials: Credentials;
}> {}

const StoredCredentials = Schema.Record(Schema.String, Schema.String);

const loadAccount = (userId: string, provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [row] = yield* db
      .select({ id: providerAccount.id, values: credential.values })
      .from(providerAccount)
      .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id))
      .where(and(eq(providerAccount.userId, userId), eq(providerAccount.provider, provider)));
    if (row === undefined) return Option.none();

    const values = yield* Schema.decodeUnknownEffect(StoredCredentials)(row.values).pipe(
      Effect.orDie,
    );
    return Option.some(
      new LinkedAccount({ id: row.id, userId, provider, credentials: toCredentials(values) }),
    );
  });

// A read takes up to a minute. An unlink or a new link during the read must not bring back the
// library of the old link.
const writeIfLinked = <A, E, R>(account: LinkedAccount, write: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const db = yield* Database;

    return yield* db.transaction(() =>
      Effect.gen(function* () {
        const [current] = yield* db
          .select({ id: providerAccount.id })
          .from(providerAccount)
          .where(
            and(
              eq(providerAccount.userId, account.userId),
              eq(providerAccount.provider, account.provider),
            ),
          );
        if (current?.id !== account.id) return yield* new AccountChanged();

        return yield* write;
      }),
    );
  });

const writeState = (
  account: LinkedAccount,
  values: Omit<typeof librarySyncState.$inferInsert, "userId" | "provider">,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(librarySyncState)
      .values({ userId: account.userId, provider: account.provider, ...values })
      .onConflictDoUpdate({
        target: [librarySyncState.userId, librarySyncState.provider],
        set: values,
      });
  });

const writeRemotePlaylist = (
  account: LinkedAccount,
  remoteId: string,
  values: Omit<typeof libraryRemotePlaylist.$inferInsert, "userId" | "provider" | "remoteId">,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    yield* db
      .insert(libraryRemotePlaylist)
      .values({ userId: account.userId, provider: account.provider, remoteId, ...values })
      .onConflictDoUpdate({
        target: [
          libraryRemotePlaylist.userId,
          libraryRemotePlaylist.provider,
          libraryRemotePlaylist.remoteId,
        ],
        set: values,
      });
  });

const writeSongs = (account: LinkedAccount, songs: ReadonlyArray<LibrarySong>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const seenAt = yield* Clock.currentTimeMillis;
    const provider = account.provider;
    const known = new Map(
      (yield* db
        .select()
        .from(libraryRemoteTrack)
        .where(
          and(
            eq(libraryRemoteTrack.userId, account.userId),
            eq(libraryRemoteTrack.provider, provider),
          ),
        )).map((row) => [row.recordingId, row]),
    );
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
          userId: account.userId,
          provider,
          recordingId,
          remoteId: song.remoteId,
          catalogId: song.catalogId,
          sourceId,
          rawTitle: song.title,
          rawArtist: song.artist,
          rawAlbum: song.album,
          rawDurationMs: song.durationMs,
          seenAt,
        };
        // Clients get the remote tracks with the group of the recording
        const old = known.get(recordingId);
        if (
          old === undefined ||
          old.remoteId !== row.remoteId ||
          old.catalogId !== row.catalogId ||
          old.sourceId !== row.sourceId ||
          old.rawTitle !== row.rawTitle ||
          old.rawArtist !== row.rawArtist ||
          old.rawAlbum !== row.rawAlbum ||
          old.rawDurationMs !== row.rawDurationMs
        ) {
          changed.push(recordingId);
        }

        yield* db
          .insert(libraryRemoteTrack)
          .values(row)
          .onConflictDoUpdate({
            target: [
              libraryRemoteTrack.userId,
              libraryRemoteTrack.provider,
              libraryRemoteTrack.recordingId,
            ],
            set: row,
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

const importSongs = (account: LinkedAccount, library: ProviderLibrary, before: LibraryProbe) =>
  Effect.gen(function* () {
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
          account.userId,
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

const importPlaylists = (account: LinkedAccount, library: ProviderLibrary) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const origin = accountOrigin(account.provider);
    const list = yield* library.playlists(account.credentials);

    const known = new Map(
      (yield* db
        .select()
        .from(libraryRemotePlaylist)
        .where(
          and(
            eq(libraryRemotePlaylist.userId, account.userId),
            eq(libraryRemotePlaylist.provider, account.provider),
          ),
        )).map((row) => [row.remoteId, row]),
    );

    const playlistIds = yield* Effect.forEach(list.items, (remote) =>
      Effect.gen(function* () {
        const playlistId = yield* uuidV5(
          `playlist:${account.userId}:${account.provider}:${remote.remoteId}`,
        );
        const now = yield* Clock.currentTimeMillis;
        const state = known.get(remote.remoteId);
        const readDue =
          remote.version === null ||
          state?.version !== remote.version ||
          state.lastCompleteAt === null ||
          now - state.lastCompleteAt >= fullReadIntervalMs;

        if (!readDue) {
          yield* writeIfLinked(
            account,
            mirrorPlaylist(account.userId, origin, playlistId, remote.name),
          );
          return playlistId;
        }

        // An incomplete read changes no entries, because a part of an ordered list has no order
        const songs = yield* library.playlistSongs(account.credentials, remote.remoteId);
        const changedEntries = yield* writeIfLinked(
          account,
          Effect.gen(function* () {
            yield* mirrorPlaylist(account.userId, origin, playlistId, remote.name);

            const incompleteReason = songs.incompleteReason;
            if (incompleteReason !== null) {
              yield* writeRemotePlaylist(account, remote.remoteId, {
                playlistId,
                incompleteReason,
              });
              return 0;
            }

            const changed = yield* replaceEntries(
              playlistId,
              yield* writeSongs(account, songs.items),
            );
            yield* writeRemotePlaylist(account, remote.remoteId, {
              playlistId,
              incompleteReason,
              version: remote.version,
              lastCompleteAt: now,
            });
            return changed;
          }),
        );

        yield* Effect.logInfo("Library playlist imported").pipe(
          Effect.annotateLogs({
            provider: account.provider,
            songs: songs.items.length,
            incompleteReason: songs.incompleteReason,
            changedEntries,
          }),
        );
        return playlistId;
      }),
    );

    if (list.incompleteReason !== null) return;

    yield* writeIfLinked(
      account,
      Effect.gen(function* () {
        const removed = yield* removePlaylists(account.userId, origin, new Set(playlistIds));
        yield* db
          .delete(libraryRemotePlaylist)
          .where(
            and(
              eq(libraryRemotePlaylist.userId, account.userId),
              eq(libraryRemotePlaylist.provider, account.provider),
              notInArray(libraryRemotePlaylist.playlistId, playlistIds),
            ),
          );

        if (removed > 0) {
          yield* Effect.logInfo("Library playlists removed").pipe(
            Effect.annotateLogs({ provider: account.provider, removed }),
          );
        }
      }),
    );
  });

const importLibrary = (account: LinkedAccount, library: ProviderLibrary) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;
    const startedAt = yield* Clock.currentTimeMillis;

    yield* writeIfLinked(account, writeState(account, { lastAttemptAt: startedAt }));
    const [state] = yield* db
      .select()
      .from(librarySyncState)
      .where(
        and(
          eq(librarySyncState.userId, account.userId),
          eq(librarySyncState.provider, account.provider),
        ),
      );

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
          jobKey(account.userId, account.provider),
          { userId: account.userId, provider: account.provider },
          { runAt: finishedAt + runIntervalMs },
        );
      }),
    );
  });

// `account` stops the runs until a new link. `failed` uses the backoff of the queue.
const recordFailure = (account: LinkedAccount, error: LibraryError) =>
  Effect.gen(function* () {
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
      .where(
        and(
          eq(librarySyncState.userId, account.userId),
          eq(librarySyncState.provider, account.provider),
        ),
      );
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

const runLibrarySync = (payload: typeof SyncPayload.Type) =>
  Effect.gen(function* () {
    const providers = yield* Providers;

    const account = yield* loadAccount(payload.userId, payload.provider);
    if (Option.isNone(account)) return;

    const library = providers.get(payload.provider)?.library;
    if (library === undefined) {
      return yield* writeIfLinked(
        account.value,
        writeState(account.value, { status: "error", error: "The provider has no library" }),
      );
    }

    return yield* importLibrary(account.value, library).pipe(
      Effect.catchTag("LibraryError", (error) => recordFailure(account.value, error)),
    );
  }).pipe(Effect.catchTag("AccountChanged", () => Effect.void));

export const queueLibrarySync = (userId: string, provider: string) =>
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const providers = yield* Providers;
    if (providers.get(provider)?.library === undefined) return;

    yield* jobs.enqueue(jobKind, jobKey(userId, provider), { userId, provider });
  });

/** Removes the imported library, its state and its job. Run it in the unlink transaction. */
export const forgetLibrary = (userId: string, provider: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const jobs = yield* Jobs;

    yield* removeOrigin(userId, accountOrigin(provider));
    yield* db
      .delete(librarySyncState)
      .where(and(eq(librarySyncState.userId, userId), eq(librarySyncState.provider, provider)));
    const removed = yield* db
      .delete(libraryRemoteTrack)
      .where(and(eq(libraryRemoteTrack.userId, userId), eq(libraryRemoteTrack.provider, provider)))
      .returning({ recordingId: libraryRemoteTrack.recordingId });
    yield* touchGroups(removed.map((row) => row.recordingId));
    yield* db
      .delete(libraryRemotePlaylist)
      .where(
        and(eq(libraryRemotePlaylist.userId, userId), eq(libraryRemotePlaylist.provider, provider)),
      );
    yield* jobs.cancel(jobKind, jobKey(userId, provider));
  });

export const syncLibrary = (provider: string) =>
  Effect.gen(function* () {
    const principal = yield* CurrentPrincipal;
    const account = yield* loadAccount(principal.userId, provider);
    if (Option.isNone(account)) return;

    yield* queueLibrarySync(principal.userId, provider);
  });

export const getLibrarySyncStatus = Effect.gen(function* () {
  const db = yield* Database;
  const providers = yield* Providers;
  const principal = yield* CurrentPrincipal;
  const userId = principal.userId;

  const accounts = yield* db
    .select({ provider: providerAccount.provider })
    .from(providerAccount)
    .where(eq(providerAccount.userId, userId));
  const linked = accounts.filter(({ provider }) => providers.get(provider)?.library !== undefined);

  return yield* Effect.forEach(linked, ({ provider }) =>
    Effect.gen(function* () {
      const [state] = yield* db
        .select()
        .from(librarySyncState)
        .where(and(eq(librarySyncState.userId, userId), eq(librarySyncState.provider, provider)));
      const [run] = yield* db
        .select({ nextRunAt: job.nextRunAt, startedAt: job.startedAt })
        .from(job)
        .where(and(eq(job.kind, jobKind), eq(job.key, jobKey(userId, provider))));

      const liveItems = and(
        eq(libraryItem.userId, userId),
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
            eq(libraryRemoteTrack.userId, libraryItem.userId),
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

    const accounts = yield* db
      .select({ userId: providerAccount.userId, provider: providerAccount.provider })
      .from(providerAccount);
    yield* Effect.forEach(
      accounts,
      (account) => queueLibrarySync(account.userId, account.provider),
      { discard: true },
    );
  }).pipe(Effect.orDie),
);
