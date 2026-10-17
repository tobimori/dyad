import type { SourceSummary } from "@dyad/domain";

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

export const songLine = (source: SourceSummary) =>
  source.artist === null ? titleOf(source) : `${titleOf(source)} · ${source.artist}`;
