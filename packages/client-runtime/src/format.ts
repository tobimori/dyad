import type { SourceSummary } from "@dyad/domain";

export const formatTime = (milliseconds: number) => {
  const seconds = Math.floor(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

export const formatDuration = (milliseconds: number | null) =>
  milliseconds === null ? "" : formatTime(milliseconds);

// The contract has no display name for a provider, so `apple_music` shows as `Apple Music`
export const formatProvider = (provider: string) =>
  provider
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

/** The provider, or the codec of a local file */
export const sourceLabel = (source: SourceSummary) =>
  source.provider === "local" ? source.codec.toUpperCase() : formatProvider(source.provider);

export const titleOf = (source: SourceSummary) => source.title ?? "Unknown title";

/** The title and the artist, for example in a list of entries that come next */
export const songLine = (source: SourceSummary) =>
  source.artist === null ? titleOf(source) : `${titleOf(source)} · ${source.artist}`;
