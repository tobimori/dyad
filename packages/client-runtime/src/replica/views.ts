import {
  libraryItem,
  libraryRemoteTrack,
  playEvent,
  playlist,
  playlistEntry,
  recording,
  source,
  sourceKey,
  sourceSegment,
  sourceVariant,
  syncScope,
} from "@dyad/db/client";
import {
  LibraryEntry,
  PlaylistEntry,
  PlaylistNotFound,
  RecordingId,
  SourceSegment,
  SourceSummary,
  libraryAlbumRef,
  libraryArtistRef,
  libraryView,
  playlistSummary,
} from "@dyad/domain";
import { and, asc, count, desc, eq, inArray, max, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Data, Effect, Option } from "effect";

import {
  AccountProviders,
  ClientDatabase,
  accountProvidersState,
  missingRecordingsState,
} from "./database.ts";

const recentPlayLimit = 100;

// The canonical recording of each source, for its fields
const bound = alias(recording, "bound");
const canonical = alias(recording, "canonical");

/**
 * The sources that the user can play, one row per source: a file on the server, or a source of a
 * provider that needs no account or has a linked one. The same rule as the server's `sourceSummary`.
 */
const playableSources = (match: SQL | undefined) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const providers = Option.getOrElse(
      yield* accountProvidersState.get,
      () => new AccountProviders({ names: {}, linked: [] }),
    );
    const names = new Map(Object.entries(providers.names));
    const linked = new Set(providers.linked);

    const rows = yield* db
      .select({
        source,
        variant: sourceVariant,
        key: sourceKey,
        canonical: {
          title: canonical.title,
          artist: canonical.artistName,
          album: canonical.album,
          explicit: canonical.explicit,
          artworkUrl: canonical.artworkUrl,
        },
      })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .leftJoin(sourceKey, eq(sourceKey.sourceId, source.id))
      .leftJoin(bound, eq(bound.id, source.recordingId))
      .leftJoin(canonical, eq(canonical.id, sql`coalesce(${bound.mergedIntoId}, ${bound.id})`))
      .where(match)
      .groupBy(source.id);

    // Local files have no provider. A source key means a file on the server.
    const usable = (provider: string) =>
      provider !== "local" && (!names.has(provider) || linked.has(provider));

    return rows
      .filter((row) => row.key !== null || usable(row.source.provider))
      .map((row) => {
        const key = row.key;
        return {
          recordingId: row.source.recordingId,
          lossless: row.variant.lossless,
          summary: new SourceSummary({
            id: row.source.id,
            provider: row.source.provider,
            title: row.canonical?.title ?? row.source.rawTitle,
            artist: row.canonical?.artist ?? row.source.rawArtist,
            album: row.canonical?.album ?? row.source.rawAlbum,
            durationMs: row.source.rawDurationMs,
            codec: row.variant.codec,
            artworkUrl: row.canonical?.artworkUrl ?? null,
            // Provider refs need the provider's IDs, which the catalog groups do not have
            artistRef: key?.artistKey == null ? null : libraryArtistRef(key.artistKey),
            albumRef:
              key?.albumArtistKey == null || key.albumKey == null
                ? null
                : libraryAlbumRef(key.albumArtistKey, key.albumKey),
            explicit: row.canonical?.explicit ?? false,
            providerName: names.get(row.source.provider) ?? null,
          }),
        };
      });
  });

// A bound recording without a row and without a "missing" answer waits for its catalog group
const loadView = (boundIds: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;

    const found = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, [...boundIds]));
    const rootOf = new Map(found.map((row) => [row.id, row.mergedIntoId ?? row.id]));
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
      .where(inArray(libraryRemoteTrack.recordingId, [...boundIds]));

    const missing = new Set<string>(Option.getOrElse(yield* missingRecordingsState.get, () => []));
    const notSynced = new Set(boundIds.filter((id) => !rootOf.has(id) && !missing.has(id)));

    return {
      view: libraryView({ recordings, sources, remoteTracks }),
      notSynced: (entry: LibraryEntry) => entry.source === null && notSynced.has(entry.recordingId),
    };
  });

/** The saved songs, from the local replica */
export const localLibrary = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  const items = yield* db
    .select({ entityId: libraryItem.entityId, addedAt: libraryItem.addedAt })
    .from(libraryItem)
    .where(eq(libraryItem.deleted, false));

  const { view, notSynced } = yield* loadView(items.map((item) => item.entityId));
  return view
    .libraryEntries(items)
    .map((entry) =>
      notSynced(entry) ? new LibraryEntry({ ...entry, unavailable: "not_synced" }) : entry,
    );
}).pipe(Effect.orDie);

export const localPlaylists = Effect.gen(function* () {
  const db = yield* ClientDatabase;
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
}).pipe(Effect.orDie);

export const localPlaylistEntries = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const [found] = yield* db
      .select({ id: playlist.id })
      .from(playlist)
      .where(and(eq(playlist.id, playlistId), eq(playlist.deleted, false)))
      .pipe(Effect.orDie);
    if (found === undefined) return yield* new PlaylistNotFound();

    const entries = yield* db
      .select()
      .from(playlistEntry)
      .where(and(eq(playlistEntry.playlistId, playlistId), eq(playlistEntry.deleted, false)))
      .orderBy(asc(playlistEntry.position), asc(playlistEntry.id))
      .pipe(Effect.orDie);
    const { view, notSynced } = yield* loadView(entries.map((entry) => entry.recordingId)).pipe(
      Effect.orDie,
    );
    return view
      .playlistEntries(entries)
      .map((entry) =>
        notSynced(entry) ? new PlaylistEntry({ ...entry, unavailable: "not_synced" }) : entry,
      );
  });

/** The playable sources of the user's last plays, newest play first, one entry per source */
export const localRecentPlays = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  const lastPlayedAt = max(playEvent.startedAt);
  const plays = yield* db
    .select({ sourceId: playEvent.sourceId, lastPlayedAt })
    .from(playEvent)
    .groupBy(playEvent.sourceId)
    .orderBy(desc(lastPlayedAt))
    .limit(recentPlayLimit);

  const rows = yield* playableSources(
    inArray(
      source.id,
      plays.map((play) => play.sourceId),
    ),
  );
  const summaries = new Map(rows.map((row) => [row.summary.id, row.summary]));
  return plays.flatMap((play) => summaries.get(play.sourceId) ?? []);
}).pipe(Effect.orDie);

/** The raw tracklist of a DJ set source: the replica rarely has its matched recordings */
export const localSourceSegments = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const rows = yield* db
      .select()
      .from(sourceSegment)
      .where(eq(sourceSegment.sourceId, sourceId))
      .orderBy(asc(sourceSegment.position));
    return rows.map(
      (row) =>
        new SourceSegment({
          startMs: row.startMs,
          endMs: row.endMs,
          title: row.rawTitle ?? "",
          artist: row.rawArtist,
          album: null,
          artistRef: null,
          albumRef: null,
          recordingId: row.recordingId === null ? null : RecordingId.make(row.recordingId),
        }),
    );
  }).pipe(Effect.orDie);

/** Which scopes have ended their first load. Until then, views show them as "Syncing". */
export class SyncProgress extends Data.Class<{
  /** `false` until the replica has reached the server once */
  readonly started: boolean;
  /** The scopes whose first load has not ended */
  readonly syncing: ReadonlySet<string>;
}> {
  get library() {
    return !this.started || [...this.syncing].some((scope) => scope.startsWith("user:"));
  }

  get playlists() {
    return !this.started || [...this.syncing].some((scope) => scope.startsWith("collection:"));
  }

  playlist(playlistId: string) {
    return !this.started || this.syncing.has(`collection:${playlistId}`);
  }
}

export const localSyncProgress = Effect.gen(function* () {
  const db = yield* ClientDatabase;
  const scopes = yield* db.select().from(syncScope);
  return new SyncProgress({
    started: scopes.length > 0,
    syncing: new Set(scopes.filter((row) => row.loadedAt === null).map((row) => row.scope)),
  });
}).pipe(Effect.orDie);
