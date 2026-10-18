import { ProviderAudio, ProviderError, ProviderVideo } from "@dyad/plugin";
import type { Credentials } from "@dyad/plugin";
import { HttpStatusError, send } from "@dyad/plugin/http";
import { NodeChildProcessSpawner } from "@effect/platform-node";
import {
  Cache,
  Clock,
  Config,
  Context,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Option,
  Path,
  Redacted,
  Ref,
  Schema,
  Stream,
} from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { readChunks } from "./api.ts";
import { clusterOffset, findCues } from "./webm.ts";

class Cookies extends Context.Service<Cookies, Credentials>()("@dyad/youtube/Cookies") {}

const webmFile = {
  format_id: Schema.String,
  url: Schema.String,
  protocol: Schema.Literal("https"),
  ext: Schema.Literal("webm"),
  filesize: Schema.Int,
  tbr: Schema.Finite,
};

// Other formats, for example HLS, MP4 or HDR video (`vp09.02…`), do not decode as these and are
// skipped
const OpusFormat = Schema.Struct({
  ...webmFile,
  acodec: Schema.Literal("opus"),
  vcodec: Schema.Literal("none"),
  // Dubbed videos have one audio track per language. The default and the original rank highest.
  language_preference: Schema.optional(Schema.NullOr(Schema.Int)),
});

const Vp9Format = Schema.Struct({
  ...webmFile,
  acodec: Schema.Literal("none"),
  vcodec: Schema.Literal("vp9"),
  height: Schema.Int,
});

const Info = Schema.fromJsonString(
  Schema.Struct({
    duration: Schema.optional(Schema.NullOr(Schema.Finite)),
    formats: Schema.Array(Schema.Unknown),
  }),
);

const hourMs = 60 * 60 * 1000;

// Enough for the head of most files. A larger `Cues` needs a second read.
const headBytes = 256 * 1024;

const signInAgain = "Sign in to YouTube again";
const blocked = "YouTube blocks this server and the YouTube account for now";

// The first sentence of yt-dlp's error, without `ERROR: [youtube] <id>: `
const errorOf = (stderr: string) =>
  stderr
    .split("\n")
    .find((line) => line.startsWith("ERROR:"))
    ?.replace(/^ERROR: (\[\w+\] [\w-]+: )?/, "")
    .split(". ")[0] ?? "yt-dlp failed";

// Netscape format, which yt-dlp reads. An expiry of 0 is a session cookie.
const cookieFile = (credentials: Credentials) =>
  [
    "# Netscape HTTP Cookie File",
    ...[...credentials].map(([name, value]) =>
      [".youtube.com", "TRUE", "/", "TRUE", "0", name, Redacted.value(value)].join("\t"),
    ),
    "",
  ].join("\n");

const webmStream = (url: string, contentLength: number, kind: "audio" | "video") =>
  Effect.gen(function* () {
    const services = yield* Effect.context<HttpClient.HttpClient>();
    // Errors contain the signed URL
    const safe = <E>(stream: Stream.Stream<Uint8Array, E, HttpClient.HttpClient>) =>
      stream.pipe(
        Stream.mapError(
          (error) =>
            new ProviderError({
              reason:
                error instanceof HttpStatusError
                  ? `YouTube answered status ${error.status}`
                  : `Cannot read the ${kind} stream`,
            }),
        ),
        Stream.provideContext(services),
      );

    const readHead = (end: number) =>
      send(HttpClientRequest.get(`${url}&range=0-${end - 1}`)).pipe(
        Effect.flatMap((response) => response.arrayBuffer),
        Effect.map((buffer) => new Uint8Array(buffer)),
      );

    // yt-dlp does not give the `indexRange` of `/player`, so the head shows where `Cues` is
    const bytesFrom = (startMs: number) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const first = yield* readHead(Math.min(headBytes, contentLength));
          const cues = yield* Effect.try(() => findCues(first));
          const head = cues.end <= first.length ? first : yield* readHead(cues.end);
          const offset = yield* Effect.try(() => clusterOffset(head, cues.start, startMs));
          return Stream.concat(
            Stream.succeed(head.subarray(0, cues.start)),
            readChunks(url, offset, contentLength),
          );
        }),
      ).pipe(safe);

    return { bytes: readChunks(url, 0, contentLength).pipe(safe), bytesFrom };
  });

/**
 * Reads the formats of a video with yt-dlp and the linked account, for when YouTube asks this
 * server to sign in. yt-dlp solves the player JavaScript challenges of the signed-in clients.
 */
export const ytdlpResolver = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner.pipe(
    Effect.provide(NodeChildProcessSpawner.layer),
  );
  const command = yield* Config.String("DYAD_YTDLP").pipe(
    Config.withDefault("yt-dlp"),
    Effect.orDie,
  );
  // After a bot check or a rejected session, the account rests for an hour
  const pausedUntil = yield* Ref.make(0);
  const missingLogged = yield* Ref.make(false);

  const pause = (reason: string) =>
    Effect.gen(function* () {
      yield* Ref.set(pausedUntil, (yield* Clock.currentTimeMillis) + hourMs);
      yield* Effect.logWarning(`yt-dlp: ${reason}. No YouTube account requests for 1 hour.`);
    });

  const run = (videoId: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        if ((yield* Clock.currentTimeMillis) < (yield* Ref.get(pausedUntil))) {
          return yield* new ProviderError({ reason: blocked });
        }

        // yt-dlp can rewrite the file, so nothing is read back from it
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "dyad-ytdlp-" });
        const cookies = path.join(directory, "cookies.txt");
        yield* fs.writeFileString(cookies, cookieFile(yield* Cookies), { mode: 0o600 });

        const child = yield* spawner.spawn(
          ChildProcess.make(command, [
            "--ignore-config",
            "-J",
            "--no-playlist",
            "--js-runtimes",
            "node",
            // yt-dlp 2026.08.19: do not force `tv_downgraded`. It fails with "The page needs to be
            // reloaded" (yt-dlp#17389), and only the defaults fall back to `web_embedded`.
            "--cookies",
            cookies,
            `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`,
          ]),
        );
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(Stream.decodeText, Stream.mkString),
            child.stderr.pipe(Stream.decodeText, Stream.mkString),
            child.exitCode,
          ],
          { concurrency: "unbounded" },
        );

        if (exitCode !== 0) {
          if (stderr.includes("no longer valid")) {
            yield* pause("YouTube ended the session of the account");
            return yield* new ProviderError({ reason: signInAgain });
          }
          const error = errorOf(stderr);
          if (/not a bot|try again later|captcha|429/i.test(error)) {
            yield* pause(error);
            return yield* new ProviderError({ reason: blocked });
          }
          return yield* new ProviderError({ reason: `yt-dlp cannot play the video: ${error}` });
        }

        const info = yield* Schema.decodeEffect(Info)(stdout);
        const decode = <S extends Schema.ConstraintDecoder<unknown>>(schema: S) =>
          info.formats.flatMap((item) => Option.toArray(Schema.decodeUnknownOption(schema)(item)));
        const audio = decode(OpusFormat);
        const video = decode(Vp9Format);

        // All URLs of an answer expire together. A stream that starts from the cache must not
        // expire before its end.
        const url = (audio[0] ?? video[0])?.url;
        const expireMs = Number(url === undefined ? 0 : new URL(url).searchParams.get("expire"));
        const lifetimeMs =
          expireMs * 1000 - (yield* Clock.currentTimeMillis) - (info.duration ?? 0) * 1000;
        return { audio, video, lifetime: Duration.millis(Math.max(0, lifetimeMs)) };
      }),
    ).pipe(
      Effect.catchTag("SchemaError", () =>
        Effect.fail(new ProviderError({ reason: "yt-dlp gave an unexpected answer" })),
      ),
      Effect.catchReason(
        "PlatformError",
        "NotFound",
        () =>
          Effect.gen(function* () {
            if (!(yield* Ref.getAndSet(missingLogged, true))) {
              yield* Effect.logWarning(
                `${command} is missing, so YouTube plays without the account. Install yt-dlp or set DYAD_YTDLP.`,
              );
            }
            return yield* new ProviderError({
              reason: "YouTube blocks this server for now, and yt-dlp is missing",
            });
          }),
        () => Effect.fail(new ProviderError({ reason: "Cannot run yt-dlp" })),
      ),
    );

  // Plays and prefetches of a video share one yt-dlp run while its URLs are valid
  const answers = yield* Cache.makeWith(run, {
    capacity: 256,
    timeToLive: (exit) => (Exit.isSuccess(exit) ? exit.value.lifetime : Duration.zero),
    requireServicesAt: "lookup",
  });

  const answerOf = (videoId: string, credentials: Credentials) =>
    credentials.size === 0
      ? Effect.fail(new ProviderError({ reason: "YouTube blocks this server for now" }))
      : Cache.get(answers, videoId).pipe(Effect.provideService(Cookies, credentials));

  return {
    /** The Opus audio, chosen like `resolveAudio` */
    audio: (videoId: string, credentials: Credentials) =>
      Effect.gen(function* () {
        const format = (yield* answerOf(videoId, credentials)).audio
          .filter((item) => !item.format_id.includes("drc"))
          .toSorted(
            (a, b) =>
              (b.language_preference ?? -1) - (a.language_preference ?? -1) || b.tbr - a.tbr,
          )[0];
        if (format === undefined) {
          return yield* new ProviderError({ reason: "The video has no Opus audio" });
        }
        return new ProviderAudio(yield* webmStream(format.url, format.filesize, "audio"));
      }),
    /** The VP9 video, chosen like `resolveVideo` */
    video: (videoId: string, credentials: Credentials, maxHeight: number) =>
      Effect.gen(function* () {
        const formats = (yield* answerOf(videoId, credentials)).video.toSorted(
          (a, b) => b.height - a.height || a.tbr - b.tbr,
        );
        const format = formats.find((item) => item.height <= maxHeight) ?? formats.at(-1);
        if (format === undefined) {
          return yield* new ProviderError({ reason: "The video has no VP9 stream" });
        }
        return new ProviderVideo(yield* webmStream(format.url, format.filesize, "video"));
      }),
    /** A new sign-in may end the rest of the account */
    resume: Ref.set(pausedUntil, 0),
  };
});
