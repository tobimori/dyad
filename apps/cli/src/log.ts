import {
  Cause,
  Config,
  Effect,
  FileSystem,
  Layer,
  Logger,
  Path,
  Predicate,
  References,
} from "effect";
import type { Context } from "effect";
import envPaths from "env-paths";

/** Logs go to `cli.log` in the log folder, because the player owns the terminal */
export const fileLogging = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const level = yield* Config.LogLevel("DYAD_LOG_LEVEL").pipe(Config.withDefault("Info"));
  const folder = envPaths("dyad", { suffix: "" }).log;

  yield* fs.makeDirectory(folder, { recursive: true });
  const logger = yield* Logger.toFile(Logger.formatLogFmt, path.join(folder, "cli.log"));

  return Layer.mergeAll(Logger.layer([logger]), Layer.succeed(References.MinimumLogLevel, level));
});

// The messages of `effect/http` 4.0.5 errors contain the request URL, and playback URLs carry a
// signature. The log keeps only the names of the error and its reason, and the status code.
const describeError = (cause: unknown) => {
  if (!(cause instanceof Error)) return "unknown";
  if (!Predicate.hasProperty(cause, "reason")) return cause.name;

  const reason = cause.reason;
  // A reason as text, for example of `PlaybackUnavailable`, comes from a fixed list
  if (Predicate.isString(reason)) return `${cause.name}(${reason})`;
  if (!(reason instanceof Error)) return cause.name;

  const response = Predicate.hasProperty(reason, "response") ? reason.response : undefined;
  const status = Predicate.hasProperty(response, "status") ? ` ${String(response.status)}` : "";
  return `${cause.name}(${reason.name}${status})`;
};

/** A short description of a failure without URLs, tokens or other values from the request */
export const describeFailure = <E>(cause: Cause.Cause<E>) =>
  cause.reasons
    .map((reason) => {
      if (Cause.isFailReason(reason)) return describeError(reason.error);
      if (Cause.isDieReason(reason)) return `defect ${describeError(reason.defect)}`;
      return "interrupted";
    })
    .join(", ");

/** Logs unhandled errors, because a crash would leave the terminal in raw mode */
export const processErrorLogging = (services: Context.Context<never>) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const log = (message: string) => (cause: unknown) => {
        // A closed output pipe is normal when the terminal goes away
        if (Predicate.hasProperty(cause, "code") && cause.code === "EPIPE") return;
        Effect.runForkWith(services)(Effect.logError(message, Cause.die(cause)));
      };
      const onException = log("Uncaught exception");
      const onRejection = log("Unhandled rejection");
      process.on("uncaughtException", onException);
      process.on("unhandledRejection", onRejection);
      return { onException, onRejection };
    }),
    (handlers) =>
      Effect.sync(() => {
        process.off("uncaughtException", handlers.onException);
        process.off("unhandledRejection", handlers.onRejection);
      }),
  );
