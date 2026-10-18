import { libraryRoot, localFile, source } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { readAudioFile } from "@dyad/media/node";
import type { AudioFile } from "@dyad/media/node";
import { eq, inArray } from "drizzle-orm";
import { Clock, Crypto, Data, Effect, FileSystem, Option, Path } from "effect";

import { requestAnalysis } from "./audio-analysis.ts";
import { tagAlbumType, tagReleaseDate } from "./editions.ts";
import { boundRecordingId } from "./ids.ts";
import { normV1 } from "./normalize.ts";
import { tagIdentifiers, writeSource } from "./sources.ts";
import type { Tags } from "./sources.ts";
import { touchGroups } from "./sync-counter.ts";

class Stat extends Data.Class<{ readonly size: number; readonly mtime: number }> {}

/**
 * The album artist rule of binding: the album artist tag, else Various Artists when the
 * compilation flag is set, else the track artist. A blank tag counts as missing.
 */
export const albumArtistOf = (tags: typeof Tags.Type) =>
  tags.album_artist?.trim() || (tags.compilation === "1" ? "Various Artists" : tags.artist);

// A blank name gives no key
const libraryKey = (name: string | undefined) => (name === undefined ? null : normV1(name) || null);

const importFile = (rootId: string, relativePath: string, file: AudioFile, stat: Stat) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const fileId = yield* crypto.randomUUIDv7();
    const scannedAt = yield* Clock.currentTimeMillis;
    const tags = Object.fromEntries(file.tags);

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        // The SQL client runs the transaction of `writeSource` as a savepoint of this one
        const sourceId = yield* writeSource(
          {
            provider: "local",
            externalId: file.audioHash,
            kind: "file",
            title: file.tags.get("title") ?? path.parse(relativePath).name,
            artist: file.tags.get("artist") ?? null,
            artists: [],
            album: file.tags.get("album") ?? null,
            durationMs: file.durationMs,
            ...tagIdentifiers(tags),
            artworkUrl: null,
            explicit: null,
            uploader: null,
            albumType: tagAlbumType(tags),
            releaseDate: tagReleaseDate(tags),
          },
          {
            codec: file.codec,
            container: file.container,
            sampleRate: file.sampleRate,
            bitDepth: file.bitDepth,
            channels: file.channels,
            bitrate: file.bitrate,
            lossless: file.lossless,
            encrypted: false,
          },
        );

        const fileRow = {
          sourceId,
          size: stat.size,
          mtime: stat.mtime,
          audioHash: file.audioHash,
          tags,
          albumArtistKey: libraryKey(albumArtistOf(tags)),
          artistKey: libraryKey(tags.artist),
          albumKey: libraryKey(tags.album),
          scannedAt,
        };
        yield* tx
          .insert(localFile)
          .values({ id: fileId, libraryRootId: rootId, path: relativePath, ...fileRow })
          .onConflictDoUpdate({ target: [localFile.libraryRootId, localFile.path], set: fileRow });
        // Clients get the library keys of the file with the group of its recording
        yield* touchGroups([yield* boundRecordingId("local", file.audioHash)]);
      }),
    );
  });

export const syncLibraryRoot = (rootPath: string, paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const crypto = yield* Crypto.Crypto;
    const root = path.resolve(rootPath);

    const createdAt = yield* Clock.currentTimeMillis;
    yield* db
      .insert(libraryRoot)
      .values({ id: yield* crypto.randomUUIDv7(), path: root, createdAt })
      .onConflictDoNothing();
    const [rootRow] = yield* db.select().from(libraryRoot).where(eq(libraryRoot.path, root));
    if (rootRow === undefined) return;

    const known = new Map(
      (yield* db.select().from(localFile).where(eq(localFile.libraryRootId, rootRow.id))).map(
        (row) => [row.path, row] as const,
      ),
    );
    const relativePaths = new Set(paths.map((file) => path.relative(root, path.resolve(file))));

    const results = yield* Effect.forEach(
      relativePaths,
      (relativePath) =>
        Effect.gen(function* () {
          const info = yield* fs.stat(path.join(root, relativePath));
          const stat = new Stat({
            size: Number(info.size),
            mtime: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
          });
          const row = known.get(relativePath);
          if (row?.size === stat.size && row.mtime === stat.mtime) return "unchanged";
          const file = yield* readAudioFile(path.join(root, relativePath));
          yield* importFile(rootRow.id, relativePath, file, stat);
          return "imported";
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Cannot import file", error).pipe(
              Effect.annotateLogs("path", relativePath),
              Effect.as("failed"),
            ),
          ),
        ),
      { concurrency: 4 },
    );

    const missing = [...known.values()].filter((row) => !relativePaths.has(row.path));
    yield* Effect.forEach(missing, (row) => db.delete(localFile).where(eq(localFile.id, row.id)), {
      discard: true,
    });
    const missingSources = yield* db
      .select({ recordingId: source.recordingId })
      .from(source)
      .where(
        inArray(
          source.id,
          missing.map((row) => row.sourceId),
        ),
      );
    yield* touchGroups(missingSources.flatMap((row) => row.recordingId ?? []));

    if (results.includes("imported")) yield* requestAnalysis;

    yield* Effect.logInfo("Library synced").pipe(
      Effect.annotateLogs({
        root,
        imported: results.filter((result) => result === "imported").length,
        unchanged: results.filter((result) => result === "unchanged").length,
        failed: results.filter((result) => result === "failed").length,
        removed: missing.length,
      }),
    );
  });
