import { Plugin } from "@dyad/plugin";
import { Config, Effect, FileSystem, Option, Path } from "effect";

// The core reads more formats through FFmpeg; these are the common audio file extensions
const audioExtensions = new Set([
  ".aac",
  ".aif",
  ".aiff",
  ".ape",
  ".flac",
  ".m4a",
  ".mp3",
  ".oga",
  ".ogg",
  ".opus",
  ".wav",
  ".wma",
  ".wv",
]);

/** Syncs the folder `DYAD_LIBRARY_DIR` once when the server starts */
export const localFilesPlugin = new Plugin({
  id: "dyad.local-files",
  setup: (context) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* Config.option(Config.NonEmptyString("DYAD_LIBRARY_DIR"));
      if (Option.isNone(root)) {
        return yield* Effect.logInfo("DYAD_LIBRARY_DIR is not set; no library folder to sync");
      }

      const entries = yield* fs.readDirectory(root.value, { recursive: true });
      const paths = entries
        // macOS writes `._` files with resource forks next to the audio files on other file systems
        .filter((entry) => audioExtensions.has(path.extname(entry).toLowerCase()))
        .filter((entry) => !path.basename(entry).startsWith("._"))
        .map((entry) => path.join(root.value, entry));
      yield* context.library.sync(root.value, paths);
    }).pipe(
      Effect.catch((error) => Effect.logError("Cannot read the library folder", error)),
      Effect.forkScoped,
      Effect.asVoid,
    ),
});
