import { ServerConnection } from "@dyad/client-runtime";
import { AudioFormat, PlaybackCapabilities } from "@dyad/domain";
import type { Audio } from "@opentui/core";
import { Array as Arr, Data, Effect, Stream } from "effect";
import { HttpClient } from "effect/http";

class PlaybackError extends Data.TaggedError("PlaybackError")<{ readonly cause: unknown }> {}

// OpenTUI 0.6.6 decodes no other compressed audio
const decoders = [
  ["mp3", new AudioFormat({ container: "mp3", codec: "mp3" })],
  ["flac", new AudioFormat({ container: "flac", codec: "flac" })],
] as const;

const capabilities = new PlaybackCapabilities({
  formats: Arr.map(decoders, ([, format]) => format),
});

/**
 * Plays one source to its end. Interrupting the effect stops the stream and the request.
 * The client declares its decoder support before requesting the negotiated stream.
 */
export const playSource = (audio: Audio, serverUrl: string, sourceId: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const connection = yield* ServerConnection;
      const plan = yield* connection.preparePlayback({ sourceId, capabilities });
      const decoder = decoders.find(
        ([, format]) =>
          format.container === plan.format.container && format.codec === plan.format.codec,
      );
      if (decoder === undefined) {
        return yield* new PlaybackError({ cause: "The server chose an undeclared format" });
      }
      const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
      const response = yield* client.get(new URL(plan.path, serverUrl));
      const body = Stream.toReadableStream(response.stream);
      const stream = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => audio.playStream(body, { format: decoder[0] }),
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
