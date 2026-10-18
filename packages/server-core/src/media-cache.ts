import type { ProviderAudio, ProviderError } from "@dyad/plugin";
import {
  Clock,
  Context,
  Data,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Redacted,
  Scope,
  Semaphore,
  Stream,
} from "effect";

export class MediaCacheConfig extends Context.Service<
  MediaCacheConfig,
  { readonly directory: string; readonly maxBytes: number }
>()("@dyad/server-core/MediaCacheConfig") {}

/**
 * A complete file of provider audio, as the provider gave it. Encrypted audio stays encrypted;
 * its keys are only in memory.
 */
export class CachedAudio extends Data.Class<{
  readonly variantId: string;
  /** CENC key IDs of the encrypted asset in the file, in hex. Empty for audio without encryption. */
  readonly keyIds: ReadonlyArray<string>;
  readonly size: number;
  readonly modifiedAt: number;
}> {}

/** A complete file and the keys that decrypt it. The keys exist only in memory. */
export class ReadyAudio extends Data.Class<{
  readonly file: CachedAudio;
  readonly decryptionKeys: Redacted.Redacted<ReadonlyMap<string, string>> | undefined;
}> {}

export class PrefetchItem extends Data.Class<{
  readonly variantId: string;
  readonly provider: string;
  readonly resolve: Effect.Effect<ProviderAudio, ProviderError>;
}> {}

// One running prefetch download. The token tells a later run of the same item apart.
class PrefetchRun extends Data.Class<{
  readonly variantId: string;
  readonly token: symbol;
  readonly fiber: Fiber.Fiber<void>;
}> {}

// `<variant ID>` or `<variant ID>.<key ID>-<key ID>`. The key IDs name the encrypted asset, so a
// file is never played with the keys of another asset of the same song.
const fileName = (file: { readonly variantId: string; readonly keyIds: ReadonlyArray<string> }) =>
  file.keyIds.length === 0 ? file.variantId : `${file.variantId}.${file.keyIds.join("-")}`;

const fileNamePattern = /^([0-9a-f-]{36})(?:\.([0-9a-f]{32}(?:-[0-9a-f]{32})*))?$/;

const makeMediaCache = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { directory, maxBytes } = yield* MediaCacheConfig;
  const layerScope = yield* Effect.scope;
  // One long DJ set must not push out the rest of the cache
  const maxFileBytes = Math.floor(maxBytes / 4);

  const files = new Map<string, CachedAudio>();
  // Open readers by variant ID. Eviction skips these files.
  const readers = new Map<string, number>();
  // Variants with a download that writes to the cache. Other downloads of them at the same time
  // are not cached.
  const writing = new Set<string>();
  // Playback downloads by provider. Prefetch waits until a provider has none.
  const liveDownloads = new Map<string, number>();
  // By session
  const hints = new Map<string, ReadonlyArray<PrefetchItem>>();
  // One prefetch download at a time for each provider, by provider
  const prefetches = new Map<string, PrefetchRun>();
  // Items whose prefetch did not give a file. A hint tries them again after they leave all hints.
  const failed = new Set<string>();
  const scheduling = yield* Semaphore.make(1);
  // Each committed file, and each cached file that playback decrypts
  const ready = yield* PubSub.unbounded<ReadyAudio>();

  const filePath = (file: { readonly variantId: string; readonly keyIds: ReadonlyArray<string> }) =>
    path.join(directory, fileName(file));

  const hinted = () => new Set([...hints.values()].flat().map((item) => item.variantId));

  const evict = Effect.gen(function* () {
    const pinned = new Set([...readers.keys(), ...hinted()]);
    const oldestFirst = [...files.values()].toSorted((a, b) => a.modifiedAt - b.modifiedAt);

    const evicted: Array<CachedAudio> = [];
    let total = oldestFirst.reduce((sum, file) => sum + file.size, 0);
    for (const file of oldestFirst) {
      if (total <= maxBytes) break;
      if (pinned.has(file.variantId)) continue;

      files.delete(file.variantId);
      evicted.push(file);
      total -= file.size;
    }

    yield* Effect.forEach(
      evicted,
      (file) =>
        fs
          .remove(filePath(file), { force: true })
          .pipe(
            Effect.catch((error) =>
              Effect.logWarning("Cannot delete a cached file", error).pipe(
                Effect.annotateLogs({ variantId: file.variantId }),
              ),
            ),
          ),
      { discard: true },
    );
  });

  // A file with its final name is complete; the rename commits it
  yield* fs.makeDirectory(directory, { recursive: true });
  for (const name of yield* fs.readDirectory(directory)) {
    if (name.endsWith(".part")) {
      yield* fs.remove(path.join(directory, name), { force: true });
      continue;
    }

    const match = fileNamePattern.exec(name);
    if (match?.[1] === undefined) continue;

    // A crash after a commit can leave the file of the earlier asset
    if (files.has(match[1])) {
      yield* fs.remove(path.join(directory, name), { force: true });
      continue;
    }

    const info = yield* fs.stat(path.join(directory, name));
    files.set(
      match[1],
      new CachedAudio({
        variantId: match[1],
        keyIds: match[2]?.split("-") ?? [],
        size: Number(info.size),
        modifiedAt: Option.match(info.mtime, { onNone: () => 0, onSome: (date) => date.getTime() }),
      }),
    );
  }
  yield* evict;

  /** The complete file of the variant. It becomes the newest file for eviction. */
  const find = (variantId: string) =>
    Effect.gen(function* () {
      const file = files.get(variantId);
      if (file === undefined) return Option.none<CachedAudio>();

      // The mtime is the eviction order on disk, because many systems mount with `noatime`
      const now = yield* Clock.currentTimeMillis;
      const touched = new CachedAudio({ ...file, modifiedAt: now });
      files.set(variantId, touched);
      return yield* fs.utimes(filePath(file), now / 1000, now / 1000).pipe(
        Effect.as(Option.some(touched)),
        Effect.catch(() =>
          Effect.sync(() => {
            files.delete(variantId);
            return Option.none<CachedAudio>();
          }),
        ),
      );
    });

  /** Reads a complete file. Eviction keeps it until the stream ends. */
  const read = (file: CachedAudio) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => readers.set(file.variantId, (readers.get(file.variantId) ?? 0) + 1)),
          () =>
            Effect.sync(() => {
              const count = (readers.get(file.variantId) ?? 1) - 1;
              if (count === 0) readers.delete(file.variantId);
              else readers.set(file.variantId, count);
            }),
        );
        return fs.stream(filePath(file));
      }),
    );

  // Gives `audio.bytes` and writes them to `<name>.part`, which the end of the bytes commits. When
  // writing stops, for example on a full disk, playback continues uncached and a prefetch ends.
  const writeThrough = (
    variantId: string,
    audio: ProviderAudio,
    afterCacheStops: "continue" | "end",
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const claimed = yield* Effect.sync(() => {
          if (writing.has(variantId)) return false;
          writing.add(variantId);
          return true;
        });
        const uncached = afterCacheStops === "continue" ? audio.bytes : Stream.empty;
        if (!claimed) return uncached;
        yield* Effect.addFinalizer(() => Effect.sync(() => writing.delete(variantId)));

        const keyIds =
          audio.decryptionKeys === undefined
            ? []
            : [...Redacted.value(audio.decryptionKeys).keys()].toSorted();
        const target = filePath({ variantId, keyIds });
        const partPath = `${target}.part`;
        const fileScope = yield* Scope.make();
        const opened = yield* fs.open(partPath, { flag: "w" }).pipe(
          Scope.provide(fileScope),
          Effect.map(Option.some),
          Effect.catch((error) =>
            Effect.logWarning("Cannot write to the media cache", error).pipe(
              Effect.annotateLogs({ variantId }),
              Effect.as(Option.none()),
            ),
          ),
        );
        if (Option.isNone(opened)) return uncached;

        const file = opened.value;
        // `open` until the commit, or until a write error or the size limit stops the writing
        const state = { open: true, size: 0 };

        const discard = Effect.gen(function* () {
          state.open = false;
          yield* Scope.close(fileScope, Exit.void);
          yield* fs.remove(partPath, { force: true }).pipe(Effect.ignore);
        });
        yield* Effect.addFinalizer(() => (state.open ? discard : Effect.void));

        const write = (chunk: Uint8Array) =>
          Effect.gen(function* () {
            if (!state.open) return;

            state.size += chunk.length;
            if (state.size > maxFileBytes) {
              yield* Effect.logInfo("Audio is too large for the cache").pipe(
                Effect.annotateLogs({ variantId }),
              );
              return yield* discard;
            }

            yield* file
              .writeAll(chunk)
              .pipe(
                Effect.catch((error) =>
                  Effect.logWarning("Cannot write to the media cache", error).pipe(
                    Effect.annotateLogs({ variantId }),
                    Effect.andThen(discard),
                  ),
                ),
              );
          });

        const commit = Effect.gen(function* () {
          if (!state.open) return;
          state.open = false;

          yield* file.sync;
          yield* Scope.close(fileScope, Exit.void);
          yield* fs.rename(partPath, target);

          const replaced = files.get(variantId);
          const now = yield* Clock.currentTimeMillis;
          const committed = new CachedAudio({
            variantId,
            keyIds,
            size: state.size,
            modifiedAt: now,
          });
          files.set(variantId, committed);
          yield* PubSub.publish(
            ready,
            new ReadyAudio({ file: committed, decryptionKeys: audio.decryptionKeys }),
          );
          // The provider replaced the asset, so the earlier file has other key IDs
          if (replaced !== undefined && filePath(replaced) !== target) {
            yield* fs.remove(filePath(replaced), { force: true });
          }
          yield* evict;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              yield* Effect.logWarning("Cannot commit a file to the media cache", error).pipe(
                Effect.annotateLogs({ variantId }),
              );
              yield* Scope.close(fileScope, Exit.void);
              yield* fs.remove(partPath, { force: true }).pipe(Effect.ignore);
            }),
          ),
        );

        const bytes = audio.bytes.pipe(Stream.tap(write));
        return (
          afterCacheStops === "continue" ? bytes : bytes.pipe(Stream.takeWhile(() => state.open))
        ).pipe(Stream.onEnd(commit));
      }),
    );

  const schedule: Effect.Effect<void> = scheduling.withPermits(1)(
    Effect.gen(function* () {
      const wanted = hinted();
      for (const [provider, run] of prefetches) {
        if (wanted.has(run.variantId)) continue;

        // The download has no reader, because a playback download is never a prefetch
        prefetches.delete(provider);
        yield* Effect.forkIn(Fiber.interrupt(run.fiber), layerScope);
      }

      const items = [...hints.values()].flat();
      for (const item of items) {
        if (files.has(item.variantId) || writing.has(item.variantId)) continue;
        if (failed.has(item.variantId) || prefetches.has(item.provider)) continue;
        if ((liveDownloads.get(item.provider) ?? 0) > 0) continue;

        const token = Symbol(item.variantId);
        const fiber = yield* item.resolve.pipe(
          Effect.flatMap((audio) => Stream.runDrain(writeThrough(item.variantId, audio, "end"))),
          Effect.tap(() =>
            Effect.sync(() => {
              if (!files.has(item.variantId)) failed.add(item.variantId);
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => failed.add(item.variantId)).pipe(
              // `ProviderError.reason` has no secrets
              Effect.andThen(Effect.logWarning("Prefetch failed", error)),
              Effect.annotateLogs({ variantId: item.variantId }),
            ),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              if (prefetches.get(item.provider)?.token === token) prefetches.delete(item.provider);
              return schedule;
            }),
          ),
          Effect.forkIn(layerScope),
        );
        prefetches.set(item.provider, new PrefetchRun({ variantId: item.variantId, token, fiber }));
      }
    }),
  );

  /**
   * Gives the bytes of a playback download and writes them to the cache. `variantId` is `null`
   * when the cache must not keep the audio, for example for a live source.
   */
  const download = (provider: string, variantId: string | null, audio: ProviderAudio) =>
    Stream.unwrap(
      Effect.gen(function* () {
        yield* Effect.acquireRelease(
          Effect.sync(() => liveDownloads.set(provider, (liveDownloads.get(provider) ?? 0) + 1)),
          () =>
            Effect.sync(() =>
              liveDownloads.set(provider, (liveDownloads.get(provider) ?? 1) - 1),
            ).pipe(Effect.andThen(schedule)),
        );
        if (variantId === null) return audio.bytes;

        // Playback takes over the prefetch of the same item. Its file starts again.
        const running = prefetches.get(provider);
        if (running?.variantId === variantId) {
          prefetches.delete(provider);
          yield* Fiber.interrupt(running.fiber);
        }
        return writeThrough(variantId, audio, "continue");
      }),
    );

  /** Replaces the hint of `session`. An empty list removes it. */
  const hint = (session: string, items: ReadonlyArray<PrefetchItem>) =>
    Effect.gen(function* () {
      if (items.length === 0) hints.delete(session);
      else hints.set(session, items);

      const wanted = hinted();
      for (const variantId of failed) {
        if (!wanted.has(variantId)) failed.delete(variantId);
      }
      yield* schedule;
    });

  /** The complete files. Unlike `find`, it does not change the eviction order. */
  const list = Effect.sync(() => [...files.values()]);

  /** Publishes the cached file to `ready`, when playback has its keys */
  const decrypted = (
    file: CachedAudio,
    decryptionKeys: Redacted.Redacted<ReadonlyMap<string, string>>,
  ) => PubSub.publish(ready, new ReadyAudio({ file, decryptionKeys }));

  return { find, read, download, hint, list, ready, decrypted };
});

/**
 * Provider audio on the disk of this replica, so that a source plays again without the
 * provider. Files are evicted by the time that they were last opened.
 */
export class MediaCache extends Context.Service<
  MediaCache,
  Effect.Success<typeof makeMediaCache>
>()("@dyad/server-core/MediaCache") {}

export const mediaCacheLayer = Layer.effect(MediaCache, makeMediaCache);
