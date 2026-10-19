import { formatTotalDuration } from "@dyad/client-runtime";
import type { AlbumPage } from "@dyad/domain";

import { albumType, counted, headed, trackRows, yearOf } from "../../component/row-list.tsx";

// All discs play as one section. Disc headings show only for more than one disc; tracks of
// other editions follow under their edition words.
export const albumPageRows = (page: AlbumPage) => {
  const rows = trackRows("track", page.tracks, "album");
  const discs = new Set(
    page.tracks.filter((track) => track.edition === null).map((track) => track.disc ?? 1),
  );
  const groupOf = (track: AlbumPage["tracks"][number]) =>
    track.edition ?? (discs.size < 2 ? null : `Disc ${track.disc ?? 1}`);

  return rows.flatMap((row, index) => {
    const group = groupOf(row.track);
    const previous = rows[index - 1];
    if (group === null || (previous !== undefined && groupOf(previous.track) === group)) {
      return [row];
    }
    return headed(`group:${group}`, group, index === 0, [row]);
  });
};

export const albumHeader = (page: AlbumPage, hint: string) => {
  const totalMs = page.tracks.reduce((total, track) => total + (track.source.durationMs ?? 0), 0);
  const details = [
    page.album === null ? "" : yearOf(page.album),
    page.album === null ? "" : albumType(page.album),
    counted(page.tracks.length, "track"),
    totalMs === 0 ? "" : formatTotalDuration(totalMs),
  ];
  return {
    title: page.album?.title ?? hint,
    subtitle: page.album?.artist ?? "",
    details: details.filter((detail) => detail !== "").join(" · "),
    artworkUrl: page.album?.artworkUrl ?? null,
  };
};
