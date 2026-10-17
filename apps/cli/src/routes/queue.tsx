import { Action } from "../component/dialog-actions.tsx";
import { ListItem, TrackList } from "../component/track-list.tsx";
import { commands } from "../context/keymap.ts";
import { Section, SectionView } from "../context/routes.ts";

const title = "Queue";

export const queue = new Section({
  id: "queue",
  title,
  order: 60,
  command: commands.queue,
  useView: (app) => {
    const player = app.player;
    const current = player.queue.current;
    const items = player.queue.entries.map(
      (entry) => new ListItem({ key: entry.key, source: entry.source, context: entry.context }),
    );

    const remove = (index: number) =>
      new Action({
        command: commands.remove,
        label: "Remove from queue",
        run: () => player.remove(index),
      });

    return new SectionView({
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
      actions: (index) => {
        const target = index ?? current;
        return target === null ? [] : [remove(target)];
      },
      render: (list) => (
        <TrackList
          title={title}
          items={items}
          selected={list.selected}
          // The queue can have the same source twice, so it marks the entry, not the source
          playing={(item) => item.key === player.current?.key}
          historyRows={current ?? 0}
          empty="The queue is empty. Press a on a track to add it."
          onSelect={list.select}
          onActivate={list.activate}
        />
      ),
    });
  },
});
