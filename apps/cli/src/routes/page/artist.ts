import { AlbumSection, TrackSection } from "@dyad/domain";
import type { ArtistPage } from "@dyad/domain";
import { Schema } from "effect";

import { AlbumRow, ArtistRow, counted, headed, trackRows } from "../../component/row-list.tsx";

const sectionHeadings = {
  top_tracks: "Top tracks",
  tracks: "Tracks",
  albums: "Albums",
  singles_eps: "Singles and EPs",
  compilations: "Compilations",
  live: "Live",
  appears_on: "Appears on",
  in_library: "In your library",
  other: "Other releases",
  similar_artists: "Similar artists",
};

// Own releases only, not "Appears on"
const isRelease = (section: AlbumSection) =>
  section.kind !== "appears_on" && section.kind !== "in_library";

// Keys use the section kind, not the position, so a new section does not move the cursor
export const artistPageRows = (page: ArtistPage) => {
  const releaseSections = page.sections.filter(Schema.is(AlbumSection)).filter(isRelease);
  const onlyOther = releaseSections.length === 1 && releaseSections[0]?.kind === "other";

  return page.sections.flatMap((section, index) => {
    const first = index === 0;

    if (Schema.is(TrackSection)(section)) {
      const rows = trackRows(section.kind, section.tracks, "artist");
      return headed(section.kind, sectionHeadings[section.kind], first, rows);
    }

    if (Schema.is(AlbumSection)(section)) {
      const label =
        onlyOther && section.kind === "other" ? "Releases" : sectionHeadings[section.kind];
      const rows = section.albums.map(
        (album) => new AlbumRow({ key: `${section.kind}:${album.ref}`, album }),
      );
      return headed(section.kind, label, first, rows);
    }

    const rows = section.artists.map(
      (artist) => new ArtistRow({ key: `${section.kind}:${artist.ref}`, artist }),
    );
    return headed(section.kind, sectionHeadings[section.kind], first, rows);
  });
};

export const artistHeader = (page: ArtistPage, hint: string) => {
  const releases = page.sections
    .filter(Schema.is(AlbumSection))
    .filter(isRelease)
    .reduce((total, section) => total + section.albums.length, 0);
  const tracks = page.sections
    .filter(Schema.is(TrackSection))
    .reduce((total, section) => total + section.tracks.length, 0);
  const details = [
    releases === 0 ? "" : counted(releases, "release"),
    tracks === 0 ? "" : counted(tracks, "track"),
  ];
  return {
    title: page.name ?? hint,
    subtitle: "Artist",
    details: details.filter((detail) => detail !== "").join(" · "),
    artworkUrl: page.artworkUrl,
  };
};
