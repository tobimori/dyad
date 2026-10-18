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

export const titleOf = (track: { readonly title: string | null }) => track.title ?? "Unknown title";

export const songLine = (source: SourceSummary) =>
  source.artist === null ? titleOf(source) : `${titleOf(source)} · ${source.artist}`;
