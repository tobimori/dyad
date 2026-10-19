import { Data, Effect, Predicate, Ref, Schedule, Schema, Stream, SubscriptionRef } from "effect";

import { CastEvent, namespaces, openChannel, receiverId, type CastChannel } from "./castv2.ts";
import {
  CommandFailed,
  DeviceBusy,
  idleState,
  TargetState,
  TargetUnreachable,
  UnsupportedFormat,
  UrlTarget,
  type CastDevice,
  type TrackMetadata,
} from "../target.ts";

/** The Default Media Receiver, which plays a URL without a custom receiver app */
const appId = "CC1AD845";

/** What the Default Media Receiver plays, from the Cast supported media list */
export const castMimeTypes = [
  "audio/flac",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/webm",
  "audio/wav",
];

const ReceiverStatus = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Struct({
      applications: Schema.optional(
        Schema.Array(
          Schema.Struct({
            appId: Schema.String,
            sessionId: Schema.String,
            transportId: Schema.String,
          }),
        ),
      ),
      volume: Schema.optional(Schema.Struct({ level: Schema.optional(Schema.Finite) })),
    }),
  }),
);

const MediaStatus = Schema.fromJsonString(
  Schema.Struct({
    status: Schema.Array(
      Schema.Struct({
        mediaSessionId: Schema.Finite,
        playerState: Schema.String,
        currentTime: Schema.optional(Schema.Finite),
        idleReason: Schema.optional(Schema.String),
        media: Schema.optional(
          Schema.Struct({
            contentId: Schema.String,
            duration: Schema.optional(Schema.NullOr(Schema.Finite)),
          }),
        ),
      }),
    ),
  }),
);

// `LOAD_FAILED`, `LOAD_CANCELLED`, `INVALID_REQUEST` and `LAUNCH_ERROR`
const Failure = Schema.fromJsonString(
  Schema.Struct({
    reason: Schema.optional(Schema.String),
    detailedErrorCode: Schema.optional(Schema.Finite),
  }),
);

class App extends Data.Class<{ readonly sessionId: string; readonly transportId: string }> {}

class Connection extends Data.Class<{
  readonly channel: CastChannel;
  readonly app: Ref.Ref<App | null>;
  readonly mediaSessionId: Ref.Ref<number | null>;
  /** Transports of apps that have a virtual connection from this sender */
  readonly connected: Set<string>;
}> {}

const statusOf = (playerState: string) => {
  if (playerState === "PLAYING") return "playing";
  if (playerState === "PAUSED") return "paused";
  if (playerState === "BUFFERING" || playerState === "LOADING") return "buffering";
  return "idle";
};

const durationOf = (seconds: number | null | undefined) =>
  seconds === null || seconds === undefined ? null : seconds * 1000;

// The fields of Cast media are optional. Unknown fields are left out instead of `null`.
const withoutNulls = (fields: Schema.JsonObject) =>
  Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== null));

const castMedia = (url: string, metadata: TrackMetadata) => ({
  contentId: url,
  contentUrl: url,
  contentType: metadata.mimeType,
  streamType: "BUFFERED",
  ...withoutNulls({ duration: metadata.durationMs === null ? null : metadata.durationMs / 1000 }),
  metadata: withoutNulls({
    // `MusicTrackMediaMetadata`
    metadataType: 3,
    title: metadata.title,
    artist: metadata.artist,
    albumName: metadata.album,
    images: metadata.artworkUrl === null ? null : [{ url: metadata.artworkUrl }],
  }),
});

/** Opens a Cast device and keeps a connection to it, with a reconnect after a failure */
export const openCast = Effect.fn("openCast")(function* (device: CastDevice) {
  const name = device.name;
  const state = yield* SubscriptionRef.make(idleState);
  const current = yield* SubscriptionRef.make<Connection | null>(null);

  const update = (
    change: (current: TargetState) => Partial<ConstructorParameters<typeof TargetState>[0]>,
  ) =>
    SubscriptionRef.update(
      state,
      (previous) => new TargetState({ ...previous, ...change(previous) }),
    );

  const failure = (command: string, event: CastEvent) =>
    Schema.decodeEffect(Failure)(event.payload).pipe(
      Effect.orElseSucceed(() => ({ reason: undefined, detailedErrorCode: undefined })),
      Effect.map(({ reason, detailedErrorCode }) => {
        const details = [event.type, reason, detailedErrorCode].filter(
          (part) => part !== undefined,
        );
        return new CommandFailed({ device: name, command, reason: details.join(" ") });
      }),
    );

  const onEvent =
    (app: Ref.Ref<App | null>, mediaSessionId: Ref.Ref<number | null>) => (event: CastEvent) =>
      Effect.gen(function* () {
        if (event.type === "RECEIVER_STATUS") {
          const { status } = yield* Schema.decodeEffect(ReceiverStatus)(event.payload);
          const running = status.applications?.find((candidate) => candidate.appId === appId);
          const level = status.volume?.level;

          if (level !== undefined) yield* update(() => ({ volume: level }));
          if (running === undefined && (yield* Ref.get(app)) !== null) {
            yield* Ref.set(mediaSessionId, null);
            yield* update(() => ({ status: "idle" }));
          }
          yield* Ref.set(app, running === undefined ? null : new App(running));
          return;
        }

        if (event.type === "MEDIA_STATUS") {
          const { status } = yield* Schema.decodeEffect(MediaStatus)(event.payload);
          const entry = status[0];
          if (entry === undefined) {
            yield* Ref.set(mediaSessionId, null);
            yield* update(() => ({ status: "idle" }));
            return;
          }

          yield* Ref.set(mediaSessionId, entry.mediaSessionId);
          yield* update((previous) => ({
            status: statusOf(entry.playerState),
            url: entry.media?.contentId ?? previous.url,
            positionMs:
              entry.currentTime === undefined ? previous.positionMs : entry.currentTime * 1000,
            durationMs:
              entry.media === undefined ? previous.durationMs : durationOf(entry.media.duration),
            error: entry.idleReason === "ERROR" ? "The device could not play the item" : null,
          }));
          return;
        }

        // The app closed its connection to this sender, for example because another app started
        if (event.namespace === namespaces.connection && event.type === "CLOSE") {
          yield* Ref.set(app, null);
          yield* Ref.set(mediaSessionId, null);
          yield* update(() => ({ status: "idle" }));
        }
      }).pipe(
        Effect.catchTag("SchemaError", (error) =>
          Effect.logDebug("Ignored an unexpected Cast message", event.type, error.message),
        ),
      );

  const session = Effect.gen(function* () {
    const app = yield* Ref.make<App | null>(null);
    const mediaSessionId = yield* Ref.make<number | null>(null);
    const connected = new Set<string>();
    const channel = yield* openChannel(device, onEvent(app, mediaSessionId));
    const connection = new Connection({ channel, app, mediaSessionId, connected });

    // Joins a Default Media Receiver that already runs, for example after a reconnect
    yield* channel.request(namespaces.receiver, receiverId, { type: "GET_STATUS" });
    const running = yield* Ref.get(app);
    if (running === null) yield* update(() => ({ status: "idle" }));
    if (running !== null) {
      yield* channel.connect(running.transportId);
      connected.add(running.transportId);
      yield* channel.request(namespaces.media, running.transportId, { type: "GET_STATUS" });
    }

    yield* SubscriptionRef.set(current, connection);
    yield* update(() => ({ error: null }));
    return yield* channel.closed;
  }).pipe(Effect.scoped, Effect.ensuring(SubscriptionRef.set(current, null)));

  yield* session.pipe(
    Effect.tapError((error) => update(() => ({ error: error.reason }))),
    Effect.retry(Schedule.min([Schedule.exponential("1 second"), Schedule.spaced("30 seconds")])),
    Effect.forkScoped,
  );

  const connection = SubscriptionRef.changes(current).pipe(
    Stream.filter(Predicate.isNotNull),
    Stream.runHead,
    Effect.flatMap(Effect.fromOption),
    Effect.timeoutOrElse({
      duration: "10 seconds",
      orElse: () => Effect.fail(new TargetUnreachable({ device: name, reason: "Not connected" })),
    }),
    Effect.catchTag("NoSuchElementError", () =>
      Effect.fail(new TargetUnreachable({ device: name, reason: "Closed" })),
    ),
  );

  // Starts the Default Media Receiver when it does not run, which ends another app on the device
  const ensureApp = Effect.fn("ensureApp")(function* (target: Connection) {
    const running = yield* Ref.get(target.app);
    if (running === null) {
      const answer = yield* target.channel.request(namespaces.receiver, receiverId, {
        type: "LAUNCH",
        appId,
      });
      if (answer.type === "LAUNCH_ERROR") {
        const error = yield* failure("load", answer);
        return yield* new DeviceBusy({ device: name, reason: error.reason });
      }
    }

    // The app can show up in a later status than the answer to `LAUNCH`
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const app = yield* Ref.get(target.app);
      if (app !== null) {
        if (!target.connected.has(app.transportId)) {
          yield* target.channel.connect(app.transportId);
          target.connected.add(app.transportId);
        }
        return app;
      }
      yield* Effect.sleep("500 millis");
    }
    return yield* new CommandFailed({ device: name, command: "load", reason: "No app" });
  });

  const expectStatus = (command: string, type: string, answer: CastEvent) =>
    answer.type === type ? Effect.void : Effect.flatMap(failure(command, answer), Effect.fail);

  const mediaCommand = Effect.fn("mediaCommand")(function* (
    command: string,
    payload: Schema.JsonObject,
  ) {
    const target = yield* connection;
    const mediaSessionId = yield* Ref.get(target.mediaSessionId);
    if (mediaSessionId === null) {
      return yield* new CommandFailed({ device: name, command, reason: "Nothing is loaded" });
    }

    const app = yield* ensureApp(target);
    const answer = yield* target.channel.request(namespaces.media, app.transportId, {
      ...payload,
      mediaSessionId,
    });
    yield* expectStatus(command, "MEDIA_STATUS", answer);
  });

  const checkFormat = (mimeType: string) =>
    device.capabilities.mimeTypes.length === 0 || device.capabilities.mimeTypes.includes(mimeType)
      ? Effect.void
      : Effect.fail(
          new UnsupportedFormat({ device: name, reason: `Cast cannot play ${mimeType}` }),
        );

  const load = Effect.fn("load")(function* (url: string, metadata: TrackMetadata, startMs: number) {
    yield* checkFormat(metadata.mimeType);
    const target = yield* connection;
    const app = yield* ensureApp(target);

    const answer = yield* target.channel.request(namespaces.media, app.transportId, {
      type: "LOAD",
      sessionId: app.sessionId,
      media: castMedia(url, metadata),
      autoplay: true,
      currentTime: startMs / 1000,
    });
    yield* expectStatus("load", "MEDIA_STATUS", answer);
  });

  const next = Effect.fn("next")(function* (url: string, metadata: TrackMetadata) {
    yield* checkFormat(metadata.mimeType);
    yield* mediaCommand("next", {
      type: "QUEUE_INSERT",
      items: [{ media: castMedia(url, metadata), autoplay: true, preloadTime: 10 }],
    });
  });

  const setVolume = Effect.fn("setVolume")(function* (volume: number) {
    const target = yield* connection;
    const level = Math.min(Math.max(volume, 0), 1);
    const answer = yield* target.channel.request(namespaces.receiver, receiverId, {
      type: "SET_VOLUME",
      volume: { level },
    });
    yield* expectStatus("setVolume", "RECEIVER_STATUS", answer);
  });

  // The receiver sends a status when the state changes, but not while the position moves
  const poll = Effect.gen(function* () {
    const { status } = yield* SubscriptionRef.get(state);
    if (status !== "playing" && status !== "buffering") return;
    yield* mediaCommand("status", { type: "GET_STATUS" });
  }).pipe(Effect.ignore);
  yield* Effect.forkScoped(Effect.repeat(poll, Schedule.spaced("1 second")));

  return new UrlTarget({
    device,
    load,
    play: mediaCommand("play", { type: "PLAY" }),
    pause: mediaCommand("pause", { type: "PAUSE" }),
    seek: (positionMs) => mediaCommand("seek", { type: "SEEK", currentTime: positionMs / 1000 }),
    stop: mediaCommand("stop", { type: "STOP" }),
    setVolume,
    next,
    // `QUEUE_REMOVE` needs the item IDs of the receiver, which this target does not keep
    clearNext: Effect.fail(
      new CommandFailed({ device: name, command: "clearNext", reason: "Not supported" }),
    ),
    state: SubscriptionRef.changes(state),
  });
});
