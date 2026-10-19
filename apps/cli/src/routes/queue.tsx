import { sourceLabel } from "@dyad/client-runtime";
import { Action } from "../component/dialog-actions.tsx";
import { useListScreen } from "../component/list-screen.tsx";
import { ListItem, TrackList } from "../component/track-list.tsx";
import { commands } from "../context/keymap.ts";
import { Section, SectionView } from "../context/routes.ts";
import type { ScreenApp } from "../context/screen-app.ts";

const title = "Queue";

function QueueScreen(props: { readonly app: ScreenApp; readonly items: ReadonlyArray<ListItem> }) {
  const player = props.app.player;
  const current = player.currentIndex;
  const items = props.items;

  const remove = (index: number) =>
    new Action({
      command: commands.remove,
      label: "Remove from queue",
      run: () => player.remove(index),
    });

  const list = useListScreen(props.app, {
    title,
    items,
    play: player.playEntry,
    keys: [
      [
        commands.remove,
        (selected) => {
          if (items[selected] !== undefined) player.remove(selected);
        },
      ],
      [commands.clear, player.clear],
    ],
    songActions: (index) => {
      const target = index ?? current;
      const autoplay = new Action({
        command: commands.autoplay,
        label: `Continue with radio when the queue ends: ${player.autoplay ? "on" : "off"}`,
        run: player.toggleAutoplay,
      });
      return target === null ? [autoplay] : [remove(target), autoplay];
    },
  });

  return (
    <TrackList
      title={title}
      items={items}
      selected={list.selected}
      // The queue can have the same source twice, so it marks the entry, not the source
      playing={(item) => item.key === String(player.current?.id)}
      historyRows={current ?? 0}
      empty="The queue is empty. Press a on a track to add it."
      onSelect={list.select}
      onActivate={list.activate}
    />
  );
}

export const queue = new Section({
  id: "queue",
  title,
  order: 60,
  command: commands.queue,
  useView: (app) => {
    const items = app.player.entries.map(
      (entry) =>
        new ListItem({
          key: String(entry.id),
          source: entry.source,
          label: sourceLabel(app.player.playingSource(entry)),
          context: entry.context,
          reason: entry.reason,
        }),
    );
    return new SectionView({
      count: items.length,
      render: () => <QueueScreen app={app} items={items} />,
    });
  },
});
