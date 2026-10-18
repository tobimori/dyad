import type { AudioFormat, AudioQuality, SourceSummary } from "@dyad/domain";

export const formatTime = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const formatDuration = (milliseconds: number | null) =>
  milliseconds === null ? "" : formatTime(milliseconds);

/** For example `1 h 12 min` */
export const formatTotalDuration = (milliseconds: number) => {
  const minutes = Math.round(milliseconds / 60_000);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min`;
};

/**
 * `names` comes from `listAccountProviders`, which has all providers of playlists and library
 * imports
 */
export const providerName = (names: ReadonlyMap<string, string>, provider: string) =>
  names.get(provider) ?? provider;

/** The provider, or the codec of a local file */
export const sourceLabel = (source: SourceSummary) =>
  source.provider === "local"
    ? source.codec.toUpperCase()
    : (source.providerName ?? source.provider);

const codecNames = new Map([
  ["flac", "FLAC"],
  ["alac", "ALAC"],
  ["aac", "AAC"],
  ["mp3", "MP3"],
  ["opus", "Opus"],
  ["vorbis", "Vorbis"],
  ["wavpack", "WavPack"],
]);

const codecName = (codec: string) =>
  codecNames.get(codec) ?? (codec.startsWith("pcm_") ? "PCM" : codec.toUpperCase());

/** For example `FLAC 24/96` or `AAC 256`. It leaves out unknown values. */
export const audioLabel = (audio: AudioQuality) => {
  const name = codecName(audio.codec);
  if (!audio.lossless) {
    return audio.bitrate === null ? name : `${name} ${Math.round(audio.bitrate / 1000)}`;
  }
  const kHz = audio.sampleRate === null ? null : audio.sampleRate / 1000;
  if (audio.bitDepth !== null && kHz !== null) return `${name} ${audio.bitDepth}/${kHz}`;
  if (kHz !== null) return `${name} ${kHz} kHz`;
  return audio.bitDepth === null ? name : `${name} ${audio.bitDepth}-bit`;
};

/**
 * For example `FLAC 24/96`, `AAC 256`, or `AAC 160 → FLAC` when the server transcodes `source` to
 * `output`. It leaves out unknown values.
 */
export const qualityLabel = (source: AudioQuality | null, output: AudioFormat) => {
  if (source === null) return codecName(output.codec);
  const label = audioLabel(source);
  return source.codec === output.codec ? label : `${label} → ${codecName(output.codec)}`;
};

export const titleOf = (track: { readonly title: string | null }) => track.title ?? "Unknown title";

export const songLine = (source: SourceSummary) =>
  source.artist === null ? titleOf(source) : `${titleOf(source)} · ${source.artist}`;
