import { formatTotalDuration, providerName } from "@dyad/client-runtime";
import type { ServerAtoms } from "@dyad/client-runtime";
import { PlaylistNotFound } from "@dyad/domain";
import type { PlaylistEntry } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { Cause, Option, Schema } from "effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMemo } from "react";

import { useLibraryStatus } from "../../component/library-notice.tsx";
import { TrackList, entryItems } from "../../component/track-list.tsx";
import type { TrackItem } from "../../component/track-list.tsx";
import { PlaylistRoute } from "../../context/routes.ts";
import type { PageRoute, SectionRoute } from "../../context/routes.ts";
import { useTheme } from "../../theme/theme.ts";

const noEntries = Atom.make(AsyncResult.initial());

// RETURN TYPE: the atoms have different types, and `useAtomValue` needs one atom type
const entriesAtom = (
  atoms: ServerAtoms,
  route: SectionRoute | PageRoute,
): Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<PlaylistEntry>, unknown>> =>
  route instanceof PlaylistRoute ? atoms.playlistEntries(route.id) : noEntries;

/** Other routes get no items. A playlist can have a song twice, so the keys are entry IDs. */
export function usePlaylist(atoms: ServerAtoms, route: SectionRoute | PageRoute) {
  const atom = entriesAtom(atoms, route);
  const result = useAtomValue(atom);
  const refresh = useAtomRefresh(atom);
  const items = useMemo(
    () =>
      entryItems(
        AsyncResult.isSuccess(result) ? result.value : [],
        "playlist",
        (entry) => entry.entryId,
        // The provider has no source of the song, so it stays out of the provider playlist
        (entry) => (entry.dyadOnly ? "Only in Dyad" : undefined),
      ),
    [result],
  );
  return { result, refresh, items };
}

function PlaylistHeader(props: {
  readonly atoms: ServerAtoms;
  readonly route: PlaylistRoute;
  readonly entries: ReadonlyArray<PlaylistEntry>;
}) {
  const theme = useTheme();
  const result = useAtomValue(props.atoms.playlists);
  const { names } = useLibraryStatus(props.atoms);
  const playlist = AsyncResult.isSuccess(result)
    ? result.value.find((candidate) => candidate.id === props.route.id)
    : undefined;

  const link = playlist?.link ?? null;
  const provider = link === null ? null : providerName(names, link.provider);
  const linkState = playlist?.linkState ?? null;
  const linkText = () => {
    if (provider === null) return "";
    if (link?.direction === "import") {
      return `Gets the changes from ${provider}. Edits here stay in Dyad.`;
    }
    if (linkState?.error != null) return linkState.error;
    if (link?.remoteId === null) return `Creates the playlist in ${provider}…`;
    if (linkState?.differs === true) {
      return `Differs from ${provider}: it cannot make some edits`;
    }
    return `Syncs with ${provider} both ways`;
  };
  const totalMs = props.entries.reduce((total, entry) => total + (entry.durationMs ?? 0), 0);
  const details = [
    provider === null ? "Playlist" : `${provider} playlist`,
    totalMs === 0 ? "" : formatTotalDuration(totalMs),
  ];

  return (
    <box flexDirection="column" height={3} marginTop={1} marginBottom={1} flexShrink={0}>
      <text wrapMode="none" fg={theme.text}>
        <strong>{playlist?.name ?? props.route.hint}</strong>
      </text>
      <text wrapMode="none" fg={theme.muted}>
        {details.filter((detail) => detail !== "").join(" · ")}
      </text>
      <text wrapMode="none" fg={theme.faint}>
        {linkText()}
      </text>
    </box>
  );
}

const isNotFound = (result: AsyncResult.AsyncResult<unknown, unknown>) =>
  AsyncResult.isFailure(result) &&
  Option.exists(Cause.findErrorOption(result.cause), Schema.is(PlaylistNotFound));

export function PlaylistView(props: {
  readonly atoms: ServerAtoms;
  readonly route: PlaylistRoute;
  readonly breadcrumb: string;
  readonly result: AsyncResult.AsyncResult<ReadonlyArray<PlaylistEntry>, unknown>;
  readonly items: ReadonlyArray<TrackItem>;
  readonly selected: number;
  readonly playing: (item: TrackItem) => boolean;
  readonly onSelect: (index: number) => void;
  readonly onActivate: (index: number) => void;
}) {
  const empty = () => {
    if (isNotFound(props.result)) {
      return "This playlist does not exist anymore. Press esc to go back.";
    }
    if (AsyncResult.isFailure(props.result))
      return "Cannot load the playlist. Press r to try again.";
    if (AsyncResult.isInitial(props.result)) return "Loading…";
    return "This playlist is empty";
  };

  return (
    <TrackList
      title={props.breadcrumb}
      header={
        <PlaylistHeader
          atoms={props.atoms}
          route={props.route}
          entries={AsyncResult.isSuccess(props.result) ? props.result.value : []}
        />
      }
      items={props.items}
      selected={props.selected}
      playing={props.playing}
      historyRows={0}
      empty={empty()}
      onSelect={props.onSelect}
      onActivate={props.onActivate}
    />
  );
}
