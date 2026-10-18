import {
  libraryItem,
  libraryRemoteTrack,
  localFile,
  playEvent,
  playlist,
  playlistEntry,
  recording,
  source,
  sourceVariant,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import {
  CatalogCursor,
  CatalogGroup,
  CatalogPage,
  LibraryRemoteTrackRow,
  RecordingId,
  RecordingRow,
  SourceKeyRow,
  SourceRow,
  SourceVariantRow,
} from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { Effect, Schema } from "effect";

const groupLimit = 500;

const GroupRoot = Schema.Struct({ id: RecordingId, revision: Schema.Int });

// The roots of the groups with a recording that the user saved, has in a readable playlist or
// played, after `cursor` in `(revision, id)` order
const referencedRoots = (userId: UserId, cursor: CatalogCursor | null) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const after =
      cursor === null
        ? sql`1`
        : sql`(root.revision, root.id) > (${cursor.revision}, ${cursor.rootId})`;

    const rows = yield* db.all(sql`
      SELECT DISTINCT root.id AS id, root.revision AS revision
      FROM recording AS member
      JOIN recording AS root ON root.id = coalesce(member.merged_into_id, member.id)
      WHERE member.id IN (
        SELECT ${libraryItem.entityId} FROM ${libraryItem}
        WHERE ${libraryItem.userId} = ${userId} AND ${libraryItem.deleted} = 0
        UNION
        SELECT ${playlistEntry.recordingId} FROM ${playlistEntry}
        JOIN ${playlist} ON ${playlist.id} = ${playlistEntry.playlistId}
        WHERE ${playlist.ownerId} = ${userId} AND ${playlist.deleted} = 0
          AND ${playlistEntry.deleted} = 0
        UNION
        SELECT ${source.recordingId} FROM ${playEvent}
        JOIN ${source} ON ${source.id} = ${playEvent.sourceId}
        WHERE ${playEvent.userId} = ${userId}
      ) AND ${after}
      ORDER BY root.revision, root.id
      LIMIT ${groupLimit + 1}
    `);
    return yield* Schema.decodeUnknownEffect(Schema.Array(GroupRoot))(rows).pipe(Effect.orDie);
  });

const loadGroups = (userId: UserId, roots: ReadonlyArray<typeof GroupRoot.Type>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rootIds = roots.map((root) => root.id);
    if (rootIds.length === 0) return [];

    const recordings = yield* db
      .select()
      .from(recording)
      .where(or(inArray(recording.id, rootIds), inArray(recording.mergedIntoId, rootIds)));
    const recordingIds = recordings.map((row) => row.id);
    const sources = yield* db
      .select()
      .from(source)
      .where(inArray(source.recordingId, recordingIds));
    const sourceIds = sources.map((row) => row.id);
    const variants = yield* db
      .select()
      .from(sourceVariant)
      .where(inArray(sourceVariant.sourceId, sourceIds));
    const keys = yield* db
      .select({
        sourceId: localFile.sourceId,
        albumArtistKey: localFile.albumArtistKey,
        artistKey: localFile.artistKey,
        albumKey: localFile.albumKey,
      })
      .from(localFile)
      .where(inArray(localFile.sourceId, sourceIds));
    const remoteTracks = yield* db
      .select()
      .from(libraryRemoteTrack)
      .where(
        and(
          eq(libraryRemoteTrack.userId, userId),
          inArray(libraryRemoteTrack.recordingId, recordingIds),
        ),
      );

    const decoded = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        recordings: Schema.Array(RecordingRow),
        sources: Schema.Array(SourceRow),
        variants: Schema.Array(SourceVariantRow),
        // Copies of one file on the server have the same keys
        keys: Schema.Array(SourceKeyRow),
        remoteTracks: Schema.Array(LibraryRemoteTrackRow),
      }),
    )({ recordings, sources, variants, keys, remoteTracks }).pipe(Effect.orDie);

    const rootOf = new Map<string, string>(
      decoded.recordings.map((row) => [row.id, row.mergedIntoId ?? row.id]),
    );
    const sourceRoot = new Map(
      decoded.sources.map((row) => [row.id, rootOf.get(row.recordingId ?? "")]),
    );

    return roots.map((root) => {
      const sourcesOfRoot = decoded.sources.filter((row) => sourceRoot.get(row.id) === root.id);
      const inGroup = new Set(sourcesOfRoot.map((row) => row.id));
      return new CatalogGroup({
        rootId: root.id,
        revision: root.revision,
        recordings: decoded.recordings.filter((row) => rootOf.get(row.id) === root.id),
        sources: sourcesOfRoot,
        variants: decoded.variants.filter((row) => inGroup.has(row.sourceId)),
        sourceKeys: [
          ...new Map(
            decoded.keys
              .filter((row) => inGroup.has(row.sourceId))
              .map((row) => [row.sourceId, row]),
          ).values(),
        ],
        remoteTracks: decoded.remoteTracks.filter((row) => rootOf.get(row.recordingId) === root.id),
      });
    });
  });

/**
 * The changed groups that the user refers to, after `cursor`, and the groups of `wanted` bound
 * recordings at any revision. `more`: groups after the new cursor remain.
 */
export const readCatalog = (
  userId: UserId,
  cursor: CatalogCursor | null,
  wanted: ReadonlyArray<RecordingId>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const changed = yield* referencedRoots(userId, cursor);
    const page = changed.slice(0, groupLimit);

    // A wanted recording that is now in a group gets the group of its root
    const found = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(recording)
      .where(inArray(recording.id, [...wanted]));
    const known = new Set<string>(page.map((root) => root.id));
    const wantedRoots = [...new Set(found.map((row) => row.mergedIntoId ?? row.id))].filter(
      (id) => !known.has(id),
    );
    const extra = yield* db
      .select({ id: recording.id, revision: recording.revision })
      .from(recording)
      .where(inArray(recording.id, wantedRoots));

    const foundIds = new Set(found.map((row) => row.id));
    const last = page.at(-1);
    return {
      page: new CatalogPage({
        groups: yield* loadGroups(userId, [
          ...page,
          ...extra.map((row) => ({ id: RecordingId.make(row.id), revision: row.revision })),
        ]),
        missing: wanted.filter((id) => !foundIds.has(id)),
        cursor:
          last === undefined
            ? cursor
            : new CatalogCursor({ revision: last.revision, rootId: last.id }),
      }),
      more: changed.length > groupLimit,
    };
  });
