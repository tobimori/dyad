import { ClientPlugin } from "@dyad/plugin/client";
import type { ClientPluginContext, NowPlaying } from "@dyad/plugin/client";
import { NodeChildProcessSpawner, NodeFileSystem, NodePath } from "@effect/platform-node";
import { Clock, Config, Effect, Layer, Option, Path, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

/** One line on the stdin of the helper */
class Update extends Schema.Class<Update>("Update")({
  state: Schema.Literals(["playing", "paused", "stopped"]),
  /** Position at the time that the helper reads the line */
  positionMs: Schema.Finite,
  title: Schema.NullOr(Schema.String),
  artist: Schema.NullOr(Schema.String),
  album: Schema.NullOr(Schema.String),
  artworkUrl: Schema.NullOr(Schema.String),
  durationMs: Schema.NullOr(Schema.Finite),
}) {}

class Command extends Schema.Class<Command>("Command")({
  event: Schema.Literals(["play", "pause", "toggle", "next", "previous"]),
}) {}

class Seek extends Schema.Class<Seek>("Seek")({
  event: Schema.Literal("seek"),
  positionMs: Schema.Finite,
}) {}

class SeekBy extends Schema.Class<SeekBy>("SeekBy")({
  event: Schema.Literal("seekBy"),
  offsetMs: Schema.Finite,
}) {}

const HelperEvent = Schema.fromJsonString(Schema.Union([Command, Seek, SeekBy]));

const stopped = new Update({
  state: "stopped",
  positionMs: 0,
  title: null,
  artist: null,
  album: null,
  artworkUrl: null,
  durationMs: null,
});

const updateOf = (nowPlaying: NowPlaying | null, now: number) => {
  if (nowPlaying === null) return stopped;

  const source = nowPlaying.source;
  const elapsed = nowPlaying.state === "playing" ? now - nowPlaying.at : 0;
  return new Update({
    state: nowPlaying.state,
    positionMs: nowPlaying.positionMs + elapsed,
    title: source.title,
    artist: source.artist,
    album: source.album,
    artworkUrl: source.artworkUrl,
    durationMs: nowPlaying.durationMs,
  });
};

const commandOf = (event: typeof HelperEvent.Type, playback: ClientPluginContext["playback"]) => {
  if (event.event === "seek") return playback.seekTo(event.positionMs);
  if (event.event === "seekBy") return playback.seekBy(event.offsetMs);
  const commands = {
    play: playback.play,
    pause: playback.pause,
    toggle: playback.togglePause,
    next: playback.next,
    previous: playback.previous,
  };
  return commands[event.event];
};

const supported = ["darwin", "linux", "win32"].includes(process.platform);

// The helper is next to the executable. macOS gives Now Playing only to an app bundle.
// `DYAD_MEDIA_CONTROLS_DIR` replaces the folder.
const helperPath = Effect.gen(function* () {
  const path = yield* Path.Path;
  const configured = yield* Config.option(Config.NonEmptyString("DYAD_MEDIA_CONTROLS_DIR"));
  const directory = Option.getOrElse(configured, () => path.dirname(process.execPath));
  if (process.platform === "darwin") {
    return path.join(
      directory,
      "dyad-media-controls.app",
      "Contents",
      "MacOS",
      "dyad-media-controls",
    );
  }
  return path.join(
    directory,
    process.platform === "win32" ? "dyad-media-controls.exe" : "dyad-media-controls",
  );
}).pipe(Effect.orDie);

/**
 * A helper process receives the media keys and shows the source in the system media controls,
 * because Node cannot run the AppKit main run loop on macOS or own an SMTC window on Windows.
 */
export const mediaControlsPlugin = new ClientPlugin({
  id: "dyad.media-controls",
  name: "Media keys",
  notice: "Media keys on. The media keys and the system media controls control Dyad.",
  enabledByDefault: supported,
  setup: (context) =>
    Effect.gen(function* () {
      if (!supported) {
        return yield* Effect.logWarning("Media keys work only on macOS, Linux and Windows");
      }

      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const executable = yield* helperPath;
      const updates = context.playback.nowPlaying.pipe(
        Stream.mapEffect((nowPlaying) =>
          Effect.map(
            Clock.currentTimeMillis,
            (now) => `${JSON.stringify(updateOf(nowPlaying, now))}\n`,
          ),
        ),
        Stream.encodeText,
      );

      // The helper exits when its stdin closes, also when the client stops without its finalizers
      const helper = yield* spawner.spawn(
        ChildProcess.make(executable, [], { stdin: updates, stderr: "pipe" }),
      );

      yield* helper.stdout.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) =>
          Schema.decodeEffect(HelperEvent)(line).pipe(
            Effect.flatMap((event) => commandOf(event, context.playback)),
            Effect.catchTag("SchemaError", (error) =>
              Effect.logWarning("Unknown event from the media keys helper", String(error)),
            ),
          ),
        ),
        Effect.andThen(Effect.logWarning("The media keys helper stopped")),
        Effect.catchCause((cause) => Effect.logWarning("The media keys helper failed", cause)),
        Effect.forkScoped,
      );
      yield* helper.stderr.pipe(
        Stream.decodeText,
        Stream.splitLines,
        Stream.runForEach((line) => Effect.logWarning("Media keys helper", line)),
        Effect.ignore,
        Effect.forkScoped,
      );
    }).pipe(
      Effect.catchTag("PlatformError", (error) =>
        Effect.logWarning("Cannot start the media keys helper", String(error)),
      ),
      Effect.provide(
        NodeChildProcessSpawner.layer.pipe(
          Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)),
        ),
      ),
    ),
});
