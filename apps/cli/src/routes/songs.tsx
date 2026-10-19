import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { LibraryNotices, accountHint, useLibraryStatus } from "../component/library-notice.tsx";
import { ListItem, TrackList, entryItems, playsSource } from "../component/track-list.tsx";
import type { TrackItem } from "../component/track-list.tsx";
import { useListScreen } from "../component/list-screen.tsx";
import { Section, SectionView } from "../context/routes.ts";
import { useReload } from "../context/screen-app.ts";
import type { ScreenApp } from "../context/screen-app.ts";

const title = "Songs";

const trackOf = (item: TrackItem) => (item instanceof ListItem ? item.source : item.entry);

const byArtistAlbumTitle = (a: TrackItem, b: TrackItem) => {
  const left = trackOf(a);
  const right = trackOf(b);
  return (
    (left.artist ?? "").localeCompare(right.artist ?? "") ||
    (left.album ?? "").localeCompare(right.album ?? "") ||
    (left.title ?? "").localeCompare(right.title ?? "")
  );
};

function SongsScreen(props: {
  readonly app: ScreenApp;
  readonly items: ReadonlyArray<TrackItem>;
  readonly notices: Parameters<typeof LibraryNotices>[0]["notices"];
  readonly empty: string;
}) {
  const list = useListScreen(props.app, { title, items: props.items });
  return (
    <TrackList
      title={title}
      header={<LibraryNotices notices={props.notices} />}
      items={props.items}
      selected={list.selected}
      playing={playsSource(props.app.player.current?.source.id)}
      historyRows={0}
      markSaved={false}
      empty={props.empty}
      onSelect={list.select}
      onActivate={list.activate}
    />
  );
}

export const songs = new Section({
  id: "songs",
  title,
  order: 20,
  command: null,
  useView: (app) => {
    const library = useAtomValue(app.atoms.library);
    const refresh = useAtomRefresh(app.atoms.library);
    const status = useLibraryStatus(app.atoms);

    const items = useMemo(
      () =>
        entryItems(
          AsyncResult.isSuccess(library) ? library.value : [],
          "library",
          (entry) => entry.source?.id ?? entry.recordingId,
        ).toSorted(byArtistAlbumTitle),
      [library],
    );

    const empty = () => {
      if (AsyncResult.isInitial(library)) return "Loading the library";
      if (AsyncResult.isFailure(library)) return "Cannot load the library. Press r to try again.";
      return (
        status.importing ??
        `No songs. ${accountHint(status.accounts)} Press shift+s on a song or a file in search to save it.`
      );
    };

    useReload(app, refresh);
    return new SectionView({
      count: items.length,
      render: () => (
        <SongsScreen app={app} items={items} notices={status.notices} empty={empty()} />
      ),
    });
  },
});
