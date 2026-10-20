import type { ArtistRef, SearchResults } from "@dyad/domain";
import { Effect } from "effect";

import { Action } from "../component/dialog-actions.tsx";
import { useDownloadActions } from "../component/dialog-downloads.tsx";
import { usePlayFromActions } from "../component/dialog-play-from.tsx";
import { useArtistProfileActions } from "../routes/artist-profiles/dialog-artist-profiles.tsx";
import { usePlaylistItemActions } from "../routes/playlists/dialog-playlists.tsx";
import { useSetActions } from "../routes/sets/dialog-sets.tsx";
import { useWebLinkActions } from "../component/dialog-web-links.tsx";
import { useMarkActions } from "../routes/library/library-marks.ts";
import { useRadioActions } from "../component/radio.ts";
import { segmentLine } from "../routes/now-playing.tsx";
import { AlbumItem, SegmentItem, SongItem } from "./action-items.ts";
import type { ActionApp, ActionItem } from "./action-items.ts";
import { commands } from "./keymap.ts";
import { Route } from "./router.ts";

const queueActions = (app: ActionApp) => (item: ActionItem) =>
  item instanceof SongItem
    ? [
        new Action({
          command: commands.playNext,
          label: "Play next",
          run: () => app.player.playNext(item.source, item.context),
        }),
        new Action({
          command: commands.addToQueue,
          label: "Add to queue",
          run: () => app.player.addToQueue([item.source], item.context),
        }),
      ]
    : [];

const videoActions = (app: ActionApp) => (item: ActionItem) =>
  item instanceof SongItem && item.source.video
    ? [
        new Action({
          command: commands.watchVideo,
          label: "Watch the video",
          run: () => app.watchVideo(item),
        }),
      ]
    : [];

// The catalog of this device answers fast and also offline. Without that exact name, the search
// screen shows the candidates: a name alone never decides.
const findPage = (app: ActionApp, name: string, open: (results: SearchResults) => boolean) => {
  const client = app.client;
  if (client === null) {
    app.searchFor(name);
    return;
  }
  app.run(
    client.searchCatalog({ query: name }).pipe(
      Effect.match({
        onFailure: () => app.searchFor(name),
        onSuccess: (results) => {
          if (!open(results)) app.searchFor(name);
        },
      }),
    ),
  );
};

const sameName = (a: string | null, b: string | null) =>
  a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();

// No "Go to" for the page that shows now; a source without a ref finds its page by name
const navigationActions = (app: ActionApp) => {
  const route = app.route;
  const goToArtist = (ref: ArtistRef | null, name: string | null) =>
    ref === null || (Route.guards.Artist(route) && route.ref === ref)
      ? []
      : [
          new Action({
            command: commands.goToArtist,
            label: `Go to artist: ${name ?? "Unknown artist"}`,
            run: () => app.openArtist(ref, name),
          }),
        ];

  return (item: ActionItem) => {
    if (item instanceof AlbumItem) return goToArtist(item.album.artistRef, item.album.artist);
    if (item instanceof SegmentItem) {
      const { artist, artistRef, album, albumRef } = item.segment;
      const list = [...goToArtist(artistRef, artist)];
      if (albumRef !== null) {
        list.push(
          new Action({
            command: commands.goToAlbum,
            label: `Go to album: ${album ?? "Unknown album"}`,
            run: () => app.openAlbum(albumRef, album, artistRef),
          }),
        );
      }
      // Unknown tracks are `ID - ID`
      if (artistRef === null && item.segment.title.toUpperCase() !== "ID") {
        const query = segmentLine(item.segment).replace(" – ", " ");
        list.push(
          new Action({
            command: commands.searchTrack,
            label: `Search the track: ${query}`,
            run: () => app.searchFor(query),
          }),
        );
      }
      return list;
    }
    if (!(item instanceof SongItem)) return [];

    const { artist, artistRef, album, albumRef } = item.source;
    // A joint credit, for example `Madonna & Charli xcx`, opens each artist
    const linked = item.source.artists.filter((credited) => credited.ref !== null);
    const list =
      linked.length > 1
        ? linked.flatMap((credited) => goToArtist(credited.ref, credited.name))
        : [...goToArtist(artistRef, artist)];
    if (artistRef === null && artist !== null) {
      list.push(
        new Action({
          command: commands.goToArtist,
          label: `Go to artist: ${artist}`,
          run: () =>
            findPage(app, artist, (results) => {
              const found = results.artists.find((card) => sameName(card.name, artist));
              if (found !== undefined) app.openArtist(found.ref, found.name);
              return found !== undefined;
            }),
        }),
      );
    }
    const showsAlbum = Route.guards.Album(route) && route.ref === albumRef;
    if (albumRef !== null && !showsAlbum) {
      list.push(
        new Action({
          command: commands.goToAlbum,
          label: `Go to album: ${album ?? "Unknown album"}`,
          run: () => app.openAlbum(albumRef, album, artistRef),
        }),
      );
    }
    if (albumRef === null && album !== null) {
      list.push(
        new Action({
          command: commands.goToAlbum,
          label: `Go to album: ${album}`,
          run: () =>
            findPage(app, `${artist ?? ""} ${album}`.trim(), (results) => {
              const found = results.albums.find(
                (card) =>
                  sameName(card.title, album) && (artist === null || sameName(card.artist, artist)),
              );
              if (found !== undefined) app.openAlbum(found.ref, found.title, found.artistRef);
              return found !== undefined;
            }),
        }),
      );
    }
    return list;
  };
};

// The order of the actions dialog. Each entry is a hook, so the list never changes.
const providers = [
  queueActions,
  useRadioActions,
  videoActions,
  navigationActions,
  usePlaylistItemActions,
  useMarkActions,
  useSetActions,
  usePlayFromActions,
  useArtistProfileActions,
  useWebLinkActions,
  useDownloadActions,
];

/** The actions of all features for an item, and then the actions of its screen */
export function useItemActions(app: ActionApp) {
  const each = providers.map((provider) => provider(app));
  return (item: ActionItem) => [
    ...each.flatMap((actions) => actions(item)),
    ...(item instanceof SongItem ? item.extra : []),
  ];
}
