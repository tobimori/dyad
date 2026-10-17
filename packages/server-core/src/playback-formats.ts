import { AudioFormat } from "@dyad/domain";
import type { AudioCodec, AudioContainer, PlaybackCapabilities } from "@dyad/domain";
import { Data, Option } from "effect";

export const contentTypes = {
  mp4: "audio/mp4",
  adts: "audio/aac",
  ogg: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
  mp3: "audio/mpeg",
};

class StreamingContainer extends Data.Class<{
  readonly container: typeof AudioContainer.Type;
  readonly codecs: ReadonlyArray<typeof AudioCodec.Type>;
}> {}

// These muxers can write sequentially, without seeking or buffering the complete track
const streamingContainers = [
  new StreamingContainer({ container: "mp4", codecs: ["aac", "alac"] }),
  new StreamingContainer({ container: "adts", codecs: ["aac"] }),
  new StreamingContainer({ container: "ogg", codecs: ["opus", "vorbis", "flac"] }),
  new StreamingContainer({ container: "webm", codecs: ["opus", "vorbis"] }),
  new StreamingContainer({ container: "flac", codecs: ["flac"] }),
  new StreamingContainer({ container: "mp3", codecs: ["mp3"] }),
];

/** FFmpeg names MP4 `mov` and raw AAC `aac`; wire formats use container names */
export const audioContainer = (name: string) => {
  if (name === "mov") return "mp4";
  if (name === "aac") return "adts";
  // FFmpeg's `matroska` can be either WebM or Matroska. Remux instead of claiming WebM support.
  return name;
};

class PlaybackChoice extends Data.Class<{
  readonly operation: "direct" | "remux" | "transcode";
  readonly format: AudioFormat;
}> {}

/** Prefers original bytes, then codec-preserving remux, then transcode to a supported format */
export const choosePlayback = (
  source: { readonly container: string; readonly codec: string },
  capabilities: PlaybackCapabilities,
) => {
  const direct = capabilities.formats.find(
    (format) => format.container === source.container && format.codec === source.codec,
  );
  // A file MP4 can have its metadata at the end. Always stream fragmented MP4 until range
  // requests and container layout are part of the direct-play path.
  if (direct !== undefined && source.container !== "mp4") {
    return Option.some(new PlaybackChoice({ operation: "direct", format: direct }));
  }

  for (const format of capabilities.formats) {
    if (format.codec !== source.codec) continue;
    const output = streamingContainers.find(
      (output) => output.container === format.container && output.codecs.includes(format.codec),
    );
    if (output !== undefined) {
      return Option.some(new PlaybackChoice({ operation: "remux", format }));
    }
  }

  const flac = capabilities.formats.find(
    (format) => format.container === "flac" && format.codec === "flac",
  );
  return flac === undefined
    ? Option.none()
    : Option.some(new PlaybackChoice({ operation: "transcode", format: flac }));
};
