import { formatTotalDuration } from "@dyad/client-runtime";
import type { AlbumPage } from "@dyad/domain";

import { albumType, counted, headed, trackRows, yearOf } from "../../component/row-list.tsx";

// All discs play as one section; disc headings show only for more than one disc
export const albumPageRows = (page: AlbumPage) => {
  const rows = trackRows("track", page.tracks, "album");
  const discs = new Set(page.tracks.map((track) => track.disc ?? 1));
  if (discs.size < 2) return rows;

  return rows.flatMap((row, index) => {
    const disc = row.track.disc ?? 1;
    const previous = rows[index - 1];
    if (previous !== undefined && (previous.track.disc ?? 1) === disc) return [row];
    return headed(`disc:${disc}`, `Disc ${disc}`, index === 0, [row]);
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
