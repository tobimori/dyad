import {
  libraryRoot,
  localFile,
  providerAccount,
  providerItem,
  source,
  sourceVariant,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import { CurrentPrincipal, SourceSummary } from "@dyad/domain";
import type { UserId } from "@dyad/domain";
import { readAudioFile } from "@dyad/media/node";
import type { AudioFile } from "@dyad/media/node";
import type { ProviderSource } from "@dyad/plugin";
import { and, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import { Clock, Crypto, Data, Effect, FileSystem, Option, Path, Schema } from "effect";

import { AccountProviders } from "./accounts.ts";
import { fromHex, hex } from "./auth.ts";
import { SourceResolvers } from "./providers.ts";

// Every catalog ID depends on this namespace; it must never change
const namespace = fromHex("5162e6fc8cee458490d95da3fb86a603");

export const uuidV5 = (name: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-1", new Uint8Array([...namespace, ...new TextEncoder().encode(name)]))
      .pipe(Effect.orDie);
    const bytes = digest.subarray(0, 16).map((byte, index) => {
      if (index === 6) return (byte & 0x0f) | 0x50;
      // RFC 9562 variant
      if (index === 8) return (byte & 0x3f) | 0x80;
      return byte;
    });
    const digits = hex(bytes);
    return `${digits.slice(0, 8)}-${digits.slice(8, 12)}-${digits.slice(12, 16)}-${digits.slice(16, 20)}-${digits.slice(20)}`;
  });

class Stat extends Data.Class<{ readonly size: number; readonly mtime: number }> {}

// Projection columns before replication assigns revisions
const projection = { policyVersion: 1, revision: 0 };

const importFile = (rootId: string, relativePath: string, file: AudioFile, stat: Stat) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const sourceId = yield* uuidV5(`local:${file.audioHash}`);
    const variantId = yield* uuidV5(`${sourceId}:variant`);
    const scannedAt = yield* Clock.currentTimeMillis;
    const fileId = yield* crypto.randomUUIDv7();
    const sourceRow = {
      provider: "local",
      externalId: file.audioHash,
      kind: "file" as const,
      rawTitle: file.tags.get("title") ?? path.parse(relativePath).name,
      rawArtist: file.tags.get("artist") ?? null,
      rawAlbum: file.tags.get("album") ?? null,
      rawDurationMs: file.durationMs,
      ...projection,
    };
    const variantRow = {
      sourceId,
      codec: file.codec,
      container: file.container,
      sampleRate: file.sampleRate,
      bitDepth: file.bitDepth,
      channels: file.channels,
      bitrate: file.bitrate,
      lossless: file.lossless,
      encrypted: false,
    };
    const fileRow = {
      sourceId,
      size: stat.size,
      mtime: stat.mtime,
      audioHash: file.audioHash,
      tags: Object.fromEntries(file.tags),
      scannedAt,
    };

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(source)
          .values({ id: sourceId, ...sourceRow })
          .onConflictDoUpdate({ target: source.id, set: sourceRow });
        yield* tx
          .insert(sourceVariant)
          .values({ id: variantId, ...variantRow })
          .onConflictDoUpdate({ target: sourceVariant.id, set: variantRow });
        yield* tx
          .insert(localFile)
          .values({ id: fileId, libraryRootId: rootId, path: relativePath, ...fileRow })
          .onConflictDoUpdate({ target: [localFile.libraryRootId, localFile.path], set: fileRow });
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

export const addProviderSource = (providerSource: ProviderSource) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const sourceId = yield* uuidV5(`${providerSource.provider}:${providerSource.externalId}`);
    const variantId = yield* uuidV5(`${sourceId}:variant`);
    const sourceRow = {
      provider: providerSource.provider,
      externalId: providerSource.externalId,
      kind: "stream" as const,
      rawTitle: providerSource.title,
      rawArtist: providerSource.artist,
      rawAlbum: providerSource.album,
      rawDurationMs: providerSource.durationMs,
      ...projection,
    };
    const variantRow = {
      sourceId,
      codec: providerSource.codec,
      container: providerSource.container,
      lossless: providerSource.lossless,
      encrypted: providerSource.encrypted,
    };

    yield* db.transaction((tx) =>
      Effect.gen(function* () {
        yield* tx
          .insert(source)
          .values({ id: sourceId, ...sourceRow })
          .onConflictDoUpdate({ target: source.id, set: sourceRow });
        yield* tx
          .insert(sourceVariant)
          .values({ id: variantId, ...variantRow })
          .onConflictDoUpdate({ target: sourceVariant.id, set: variantRow });
      }),
    );
  });

export const Tags = Schema.Record(Schema.String, Schema.String);

// Tags such as `3/12` give the position and the total
const position = (tags: typeof Tags.Type, key: string, fallback: number) =>
  Number.parseInt(tags[key] ?? "", 10) || fallback;

/** Query for the sources with a file on this replica, or with a resolver and, if the provider needs one, an account of the user */
export const selectPlayableSources = (userId: UserId, match?: SQL) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const resolvers = yield* SourceResolvers;
    const accountProviders = yield* AccountProviders;
    const accounts = yield* db
      .select({ provider: providerAccount.provider })
      .from(providerAccount)
      .where(eq(providerAccount.userId, userId));
    const linkedProviders = new Set(accounts.map((account) => account.provider));
    const playableProviders = [...resolvers.keys()].filter(
      (provider) => !accountProviders.has(provider) || linkedProviders.has(provider),
    );

    return db
      .select({
        source,
        variant: sourceVariant,
        tags: localFile.tags,
        // The catalog has no artwork yet. A provider source has it while its search result is cached.
        artworkUrl: sql<string | null>`json_extract(${providerItem.data}, '$.artworkUrl')`,
      })
      .from(source)
      .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
      .leftJoin(localFile, eq(localFile.sourceId, source.id))
      .leftJoin(providerItem, eq(providerItem.sourceId, source.id))
      .where(and(or(isNotNull(localFile.id), inArray(source.provider, playableProviders)), match));
  });

export const sourceSummary = (row: {
  readonly source: typeof source.$inferSelect;
  readonly variant: typeof sourceVariant.$inferSelect;
  readonly artworkUrl: string | null;
}) =>
  new SourceSummary({
    id: row.source.id,
    provider: row.source.provider,
    title: row.source.rawTitle,
    artist: row.source.rawArtist,
    album: row.source.rawAlbum,
    durationMs: row.source.rawDurationMs,
    codec: row.variant.codec,
    artworkUrl: row.artworkUrl,
  });

/** Playable sources in album order */
export const listSources = Effect.gen(function* () {
  const principal = yield* CurrentPrincipal;
  const query = yield* selectPlayableSources(principal.userId);
  const rows = yield* query;
  const unique = [...new Map(rows.map((row) => [row.source.id, row] as const)).values()];

  return unique
    .map((row) => {
      const tags = Option.getOrElse(Schema.decodeUnknownOption(Tags)(row.tags), () => ({}));
      return {
        summary: sourceSummary(row),
        disc: position(tags, "disc", 1),
        track: position(tags, "track", 0),
      };
    })
    .toSorted(
      (a, b) =>
        (a.summary.artist ?? "").localeCompare(b.summary.artist ?? "") ||
        (a.summary.album ?? "").localeCompare(b.summary.album ?? "") ||
        a.disc - b.disc ||
        a.track - b.track ||
        (a.summary.title ?? "").localeCompare(b.summary.title ?? ""),
    )
    .map((entry) => entry.summary);
});
