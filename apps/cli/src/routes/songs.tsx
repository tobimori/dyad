import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { LibraryNotices, accountHint, useLibraryStatus } from "../component/library-notice.tsx";
import {
  ListItem,
  TrackList,
  entryItems,
  listItems,
  playsSource,
} from "../component/track-list.tsx";
import type { TrackItem } from "../component/track-list.tsx";
import { Section, SectionView } from "../context/routes.ts";

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

export const songs = new Section({
  id: "songs",
  title,
  order: 20,
  command: null,
  useView: (app) => {
    const library = useAtomValue(app.atoms.library);
    const files = useAtomValue(app.atoms.sources);
    const refreshLibrary = useAtomRefresh(app.atoms.library);
    const refreshFiles = useAtomRefresh(app.atoms.sources);
    const status = useLibraryStatus(app.atoms);

    // The library has only saved songs. It gives a merged local file as the entry's source, so
    // the file shows once.
    const items = useMemo(() => {
      const entries = AsyncResult.isSuccess(library) ? library.value : [];
      const inLibrary = new Set(entries.flatMap((entry) => entry.source?.id ?? []));
      const local = (AsyncResult.isSuccess(files) ? files.value : []).filter(
        (source) => !inLibrary.has(source.id),
      );

      return [
        ...entryItems(entries, "library", (entry) => entry.source?.id ?? entry.recordingId),
        ...listItems(local, "library"),
      ].toSorted(byArtistAlbumTitle);
    }, [library, files]);

    const empty = () => {
      if (AsyncResult.isInitial(library) || AsyncResult.isInitial(files)) {
        return "Loading the library";
      }
      if (AsyncResult.isFailure(library) && AsyncResult.isFailure(files)) {
        return "Cannot load the library. Press r to try again.";
      }
      return (
        status.importing ??
        `No songs. ${accountHint(status.accounts)} Files that you add to the server show here too.`
      );
    };

    return new SectionView({
      items,
      refresh: () => {
        refreshLibrary();
        refreshFiles();
      },
      render: (list) => (
        <TrackList
          title={title}
          header={<LibraryNotices notices={status.notices} />}
          items={items}
          selected={list.selected}
          playing={playsSource(app.player.current?.source.id)}
          historyRows={0}
          markSaved={false}
          empty={empty()}
          onSelect={list.select}
          onActivate={list.activate}
        />
      ),
    });
  },
});
