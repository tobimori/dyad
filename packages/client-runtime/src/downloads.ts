import {
  AlbumRef,
  AudioFormat,
  AudioQuality,
  DownloadQuality,
  DownloadUnavailable,
} from "@dyad/domain";
import type { AudioContainer, PlaybackCapabilities } from "@dyad/domain";
import {
  Cause,
  Clock,
  Context,
  Data,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  Queue,
  Schema,
  Semaphore,
  Stream,
  SubscriptionRef,
} from "effect";
import { HttpClient } from "effect/http";

import { ConnectionStatus, ServerConnection } from "./connection.ts";

/** What the user downloaded on this device. An album or playlist follows its changes. */
export class DownloadPin extends Schema.Class<DownloadPin>("DownloadPin")({
  kind: Schema.Literals(["song", "album", "playlist"]),
  /** A source ID, an album ref or a playlist ID */
  id: Schema.String,
  title: Schema.String,
  quality: DownloadQuality,
  /** The sources of the album or playlist when the device last read it */
  sourceIds: Schema.Array(Schema.String),
}) {}

export class DownloadedFile extends Schema.Class<DownloadedFile>("DownloadedFile")({
  sourceId: Schema.String,
  /** Name in the downloads folder */
  file: Schema.String,
  format: AudioFormat,
  bytes: Schema.Int,
  /** Server time. The device deletes the file after it, unless a check-in renews it. */
  leaseExpiresAt: Schema.NullOr(Schema.Finite),
  /** `null` in indexes from before it and from older servers */
  audio: Schema.NullOr(AudioQuality).pipe(Schema.withDecodingDefaultKey(Effect.succeed(null))),
}) {}

const DownloadIndex = Schema.fromJsonString(
  Schema.Struct({ pins: Schema.Array(DownloadPin), files: Schema.Array(DownloadedFile) }),
);

export class DownloadsState extends Data.Class<{
  readonly pins: ReadonlyArray<DownloadPin>;
  readonly files: ReadonlyMap<string, DownloadedFile>;
  readonly active: { readonly sourceId: string; readonly bytes: number } | null;
  /** Why the last download of a source failed. A later run tries again. */
  readonly failures: ReadonlyMap<string, DownloadUnavailable["reason"] | "failed">;
}> {}

/** The codec depends on what the device decodes, so the labels name none */
export const downloadQualities = [
  ["original", "Original"],
  ["lossless", "Lossless (FLAC 16-bit)"],
  ["high", "High (256 kbps)"],
  ["normal", "Normal (128 kbps)"],
  ["data_saver", "Data saver"],
] as const satisfies ReadonlyArray<readonly [typeof DownloadQuality.Type, string]>;

/** The progress of one pin, for display */
export const pinProgress = (state: DownloadsState, pin: DownloadPin) => ({
  done: pin.sourceIds.filter((id) => state.files.has(id)).length,
  total: pin.sourceIds.length,
  failed: pin.sourceIds.filter((id) => state.failures.has(id) && !state.files.has(id)).length,
  bytes: pin.sourceIds.reduce((sum, id) => sum + (state.files.get(id)?.bytes ?? 0), 0),
  downloading: state.active !== null && pin.sourceIds.includes(state.active.sourceId),
});

const extensions = {
  mp3: "mp3",
  flac: "flac",
  mp4: "m4a",
  adts: "aac",
  ogg: "ogg",
  webm: "webm",
} satisfies Record<typeof AudioContainer.Type, string>;

const indexFile = "index.json";
// A device online for a long time still renews its leases and follows its playlists
const checkInterval = "1 hour";

const makeDownloads = Effect.fnUntraced(function* (options: {
  /** One folder per server, because source IDs and leases belong to one server */
  readonly directory: string;
  readonly serverUrl: string;
  readonly capabilities: PlaybackCapabilities;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const connection = yield* ServerConnection;
  const status = yield* ConnectionStatus;
  const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
  const directory = options.directory;
  const pathOf = (file: string) => path.join(directory, file);

  yield* fs.makeDirectory(directory, { recursive: true });
  // A broken index gives no downloads; the sweep below deletes their files
  const index = yield* fs.readFileString(pathOf(indexFile)).pipe(
    Effect.flatMap(Schema.decodeEffect(DownloadIndex)),
    Effect.orElseSucceed(() => ({ pins: [], files: [] })),
  );
  // Files that a quit interrupted, or that the index lost
  const names = new Set(yield* fs.readDirectory(directory));
  const files = index.files.filter((file) => names.has(file.file));
  const known = new Set([indexFile, ...files.map((file) => file.file)]);
  for (const name of names) {
    if (!known.has(name)) yield* fs.remove(pathOf(name)).pipe(Effect.ignore);
  }

  const state = yield* SubscriptionRef.make(
    new DownloadsState({
      pins: index.pins,
      files: new Map(files.map((file) => [file.sourceId, file])),
      active: null,
      failures: new Map(),
    }),
  );
  const update = (change: (current: DownloadsState) => Partial<DownloadsState>) =>
    SubscriptionRef.update(
      state,
      (current) => new DownloadsState({ ...current, ...change(current) }),
    );

  const saving = yield* Semaphore.make(1);
  // The rename replaces the index at once, so a quit never leaves half of it
  const save = saving
    .withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(state);
        const text = yield* Schema.encodeEffect(DownloadIndex)({
          pins: current.pins,
          files: [...current.files.values()],
        });
        yield* fs.writeFileString(pathOf(`${indexFile}.tmp`), text);
        yield* fs.rename(pathOf(`${indexFile}.tmp`), pathOf(indexFile));
      }),
    )
    .pipe(Effect.catchCause((cause) => Effect.logWarning("Cannot save the downloads", cause)));

  const removeFiles = Effect.fnUntraced(function* (sourceIds: ReadonlyArray<string>) {
    if (sourceIds.length === 0) return;
    const current = yield* SubscriptionRef.get(state);
    for (const sourceId of sourceIds) {
      const file = current.files.get(sourceId);
      if (file !== undefined) yield* fs.remove(pathOf(file.file)).pipe(Effect.ignore);
    }
    yield* update((latest) => {
      const kept = new Map(latest.files);
      for (const sourceId of sourceIds) kept.delete(sourceId);
      return { files: kept };
    });
    yield* save;
  });

  // The first pin of a source decides its quality
  const wanted = (pins: ReadonlyArray<DownloadPin>) => {
    const qualities = new Map<string, typeof DownloadQuality.Type>();
    for (const pin of pins) {
      for (const sourceId of pin.sourceIds) {
        if (!qualities.has(sourceId)) qualities.set(sourceId, pin.quality);
      }
    }
    return qualities;
  };

  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const current = yield* SubscriptionRef.get(state);
    const keep = wanted(current.pins);
    const expired = (file: DownloadedFile) =>
      file.leaseExpiresAt !== null && file.leaseExpiresAt < now;
    yield* removeFiles(
      [...current.files.values()].flatMap((file) =>
        !keep.has(file.sourceId) || expired(file) ? [file.sourceId] : [],
      ),
    );
  });

  // A failed read keeps the last sources; only a missing album or playlist empties the pin
  const expand = Effect.fnUntraced(
    function* (pin: DownloadPin) {
      if (pin.kind === "song") return pin.sourceIds;
      if (pin.kind === "playlist") {
        const entries = yield* connection.listPlaylistEntries({ playlistId: pin.id });
        return entries.flatMap((entry) => (entry.source === null ? [] : [entry.source.id]));
      }
      const ref = yield* Schema.decodeEffect(AlbumRef)(pin.id);
      const page = yield* Stream.runLast(connection.albumPage({ ref }));
      return Option.match(page, {
        onNone: () => pin.sourceIds,
        onSome: (album) =>
          album.tracks.flatMap((track) => (track.playable ? [track.source.id] : [])),
      });
    },
    (effect, pin) =>
      effect.pipe(
        Effect.timeout("30 seconds"),
        Effect.catchTags({
          PageNotFound: () => Effect.succeed([]),
          PlaylistNotFound: () => Effect.succeed([]),
        }),
        Effect.orElseSucceed(() => pin.sourceIds),
      ),
  );

  const download = Effect.fnUntraced(
    function* (sourceId: string, quality: typeof DownloadQuality.Type) {
      const plan = yield* connection.prepareDownload({
        sourceId,
        quality,
        capabilities: options.capabilities,
      });
      const part = pathOf(`${sourceId}.part`);
      yield* update(() => ({ active: { sourceId, bytes: 0 } }));
      const response = yield* http.get(new URL(plan.path, options.serverUrl));
      let bytes = 0;
      yield* response.stream.pipe(
        Stream.tap((chunk) => {
          bytes += chunk.length;
          return update(() => ({ active: { sourceId, bytes } }));
        }),
        Stream.run(fs.sink(part)),
      );

      const file = new DownloadedFile({
        sourceId,
        file: `${sourceId}.${extensions[plan.format.container]}`,
        format: plan.format,
        bytes,
        leaseExpiresAt: plan.leaseExpiresAt,
        audio: plan.audio,
      });
      yield* fs.rename(part, pathOf(file.file));
      yield* update((current) => {
        const failures = new Map(current.failures);
        failures.delete(sourceId);
        return { files: new Map(current.files).set(sourceId, file), failures };
      });
      yield* save;
    },
    (effect, sourceId) =>
      effect.pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const unavailable = Cause.findErrorOption(cause).pipe(
              Option.filter(Schema.is(DownloadUnavailable)),
              Option.match({ onNone: () => "failed" as const, onSome: (error) => error.reason }),
            );
            yield* Effect.logWarning("Cannot download", cause).pipe(
              Effect.annotateLogs({ sourceId }),
            );
            yield* fs.remove(pathOf(`${sourceId}.part`)).pipe(Effect.ignore);
            yield* update((current) => ({
              failures: new Map(current.failures).set(sourceId, unavailable),
            }));
          }),
        ),
        Effect.ensuring(update(() => ({ active: null }))),
      ),
  );

  const checkIn = Effect.gen(function* () {
    const current = yield* SubscriptionRef.get(state);
    const leases = yield* connection.checkInDownloads({ sourceIds: [...current.files.keys()] });
    const renewed = new Map(leases.map((lease) => [lease.sourceId, lease.leaseExpiresAt]));
    yield* removeFiles([...current.files.keys()].filter((sourceId) => !renewed.has(sourceId)));
    yield* update((latest) => ({
      files: new Map(
        [...latest.files].map(([sourceId, file]) => [
          sourceId,
          new DownloadedFile({ ...file, leaseExpiresAt: renewed.get(sourceId) ?? null }),
        ]),
      ),
    }));
    yield* save;
  });

  const run = Effect.gen(function* () {
    yield* sweep;
    if ((yield* SubscriptionRef.get(status)) !== "connected") return;

    const pins = (yield* SubscriptionRef.get(state)).pins;
    const expanded = new Map(
      yield* Effect.forEach(pins, (pin) =>
        Effect.map(expand(pin), (sourceIds) => [pin, sourceIds] as const),
      ),
    );
    // A pin that the user changed or removed meanwhile stays as the user left it
    yield* update((current) => ({
      pins: current.pins.map((pin) => {
        const sourceIds = expanded.get(pin);
        return sourceIds === undefined ? pin : new DownloadPin({ ...pin, sourceIds });
      }),
    }));
    yield* save;
    yield* sweep;

    for (const [sourceId, quality] of wanted((yield* SubscriptionRef.get(state)).pins)) {
      const current = yield* SubscriptionRef.get(state);
      if (current.files.has(sourceId) || !wanted(current.pins).has(sourceId)) continue;
      if ((yield* SubscriptionRef.get(status)) !== "connected") return;
      yield* download(sourceId, quality);
    }
    yield* checkIn;
  }).pipe(Effect.catchCause((cause) => Effect.logWarning("Downloads failed", cause)));

  const wake = yield* Queue.sliding<void>(1);
  yield* SubscriptionRef.changes(status).pipe(
    Stream.filter((current) => current === "connected"),
    Stream.runForEach(() => Queue.offer(wake, undefined)),
    Effect.forkScoped,
  );
  yield* run.pipe(
    Effect.andThen(Effect.race(Queue.take(wake), Effect.sleep(checkInterval))),
    Effect.forever,
    Effect.forkScoped,
  );

  const changePins = (change: (pins: ReadonlyArray<DownloadPin>) => ReadonlyArray<DownloadPin>) =>
    update((current) => ({ pins: change(current.pins) })).pipe(
      Effect.andThen(save),
      Effect.andThen(Queue.offer(wake, undefined)),
    );

  return {
    state,
    /** Replaces a pin of the same kind and ID */
    pin: (pin: DownloadPin) =>
      changePins((pins) => [
        ...pins.filter((other) => other.kind !== pin.kind || other.id !== pin.id),
        pin,
      ]),
    /** Deletes the files that no other pin needs. The server forgets them at the next check-in. */
    unpin: (kind: DownloadPin["kind"], id: string) =>
      changePins((pins) => pins.filter((pin) => pin.kind !== kind || pin.id !== id)),
    /** The complete file of a source whose lease has not ended */
    file: (sourceId: string) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const file = (yield* SubscriptionRef.get(state)).files.get(sourceId);
        if (file === undefined || (file.leaseExpiresAt !== null && file.leaseExpiresAt < now)) {
          return Option.none();
        }
        return Option.some({ path: pathOf(file.file), format: file.format, audio: file.audio });
      }),
  };
});

/** The files that this device keeps to play without the server */
export class Downloads extends Context.Service<
  Downloads,
  Effect.Success<ReturnType<typeof makeDownloads>>
>()("@dyad/client-runtime/Downloads") {}

export const downloadsLayer = (options: Parameters<typeof makeDownloads>[0]) =>
  Layer.effect(Downloads, makeDownloads(options));
