import type { Audio } from "@opentui/core";
import { Data, Effect, Stream } from "effect";
import { HttpClient } from "effect/http";

class PlaybackError extends Data.TaggedError("PlaybackError")<{ readonly cause: unknown }> {}

/**
 * Plays one source to its end. Interrupting the effect stops the stream and the request.
 * OpenTUI 0.6.6 detects no format, so the response `Content-Type` selects it; the server sends
 * MP3 or FLAC.
 */
export const playSource = (audio: Audio, serverUrl: string, sourceId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const response = yield* client.get(new URL(`/stream/${sourceId}`, serverUrl));
      const format = response.headers["content-type"] === "audio/mpeg" ? "mp3" : "flac";
      const body = Stream.toReadableStream(response.stream);
      const stream = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => audio.playStream(body, { format }),
          catch: (cause) => new PlaybackError({ cause }),
        }),
        (stream) => Effect.sync(() => stream.dispose()),
      );
      yield* Effect.callback<void, PlaybackError>((resume) => {
        stream.once("ended", () => resume(Effect.void));
        stream.once("error", (cause) => resume(Effect.fail(new PlaybackError({ cause }))));
      });
    }),
  );
