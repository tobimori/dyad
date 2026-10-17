import { AudioFormat, PlaybackUnavailable } from "@dyad/domain";
import type { AudioCodec, AudioContainer, PlaybackCapabilities } from "@dyad/domain";
import { Data, Effect } from "effect";

export const contentTypes = {
  mp4: "audio/mp4",
  adts: "audio/aac",
  ogg: "audio/ogg",
  webm: "audio/webm",
  flac: "audio/flac",
  mp3: "audio/mpeg",
} satisfies Record<typeof AudioContainer.Type, string>;

// These muxers can write sequentially, without seeking or buffering the complete track
const streamingCodecs = {
  mp4: ["aac", "alac"],
  adts: ["aac"],
  ogg: ["opus", "vorbis", "flac"],
  webm: ["opus", "vorbis"],
  flac: ["flac"],
  mp3: ["mp3"],
} satisfies Record<typeof AudioContainer.Type, ReadonlyArray<typeof AudioCodec.Type>>;

/** FFmpeg names MP4 `mov` and raw AAC `aac`; wire formats use container names */
export const audioContainer = (name: string) => {
  if (name === "mov") return "mp4";
  if (name === "aac") return "adts";
  // FFmpeg's `matroska` can be either WebM or Matroska. Remux instead of claiming WebM support.
  return name;
};

/** Container and codec of a source. They can be formats that no client accepts. */
export class SourceFormat extends Data.Class<{
  readonly container: string;
  readonly codec: string;
}> {}

class PlaybackChoice extends Data.Class<{
  readonly operation: "direct" | "remux" | "transcode";
  readonly format: AudioFormat;
}> {}

/** Prefers original bytes, then codec-preserving remux, then transcode to a supported format */
export const choosePlayback = (source: SourceFormat, capabilities: PlaybackCapabilities) => {
  const direct = capabilities.formats.find(
    (format) => format.container === source.container && format.codec === source.codec,
  );
  // A file MP4 can have its metadata at the end. Always stream fragmented MP4 until range
  // requests and container layout are part of the direct-play path.
  if (direct !== undefined && source.container !== "mp4") {
    return Effect.succeed(new PlaybackChoice({ operation: "direct", format: direct }));
  }

  for (const format of capabilities.formats) {
    if (format.codec !== source.codec) continue;
    const codecs = streamingCodecs[format.container];
    if (codecs.some((codec) => codec === format.codec)) {
      return Effect.succeed(new PlaybackChoice({ operation: "remux", format }));
    }
  }

  const flac = capabilities.formats.find(
    (format) => format.container === "flac" && format.codec === "flac",
  );
  return flac === undefined
    ? Effect.fail(new PlaybackUnavailable({ reason: "unsupported_format" }))
    : Effect.succeed(new PlaybackChoice({ operation: "transcode", format: flac }));
};
