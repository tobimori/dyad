import { DownloadPin, downloadQualities, pinProgress, titleOf } from "@dyad/client-runtime";
import type { Downloads } from "@dyad/client-runtime";
import type { DownloadQuality } from "@dyad/domain";
import { Effect, Fiber, Stream, SubscriptionRef } from "effect";
import { useEffect, useState } from "react";

import { AlbumItem, SongItem } from "../context/action-items.ts";
import type { ActionApp, ActionItem } from "../context/action-items.ts";
import { commands } from "../context/keymap.ts";
import type { Command } from "../context/keymap.ts";
import { useToast } from "../ui/toast.tsx";
import { Action, ActionsDialog } from "./dialog-actions.tsx";
import { Dialog, useDialog } from "../ui/dialog.tsx";
import { SelectList, SelectOption } from "../ui/select-list.tsx";

const downloadsWidth = 60;

const megabytes = (bytes: number) =>
  `${(bytes / 1024 / 1024).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;

/** Choosing a quality closes the dialog */
export function QualityDialog(props: {
  readonly title: string;
  readonly current: typeof DownloadQuality.Type;
  readonly onChoose: (quality: typeof DownloadQuality.Type) => void;
}) {
  const dialog = useDialog();
  const options = downloadQualities.map(
    ([quality, label]) =>
      new SelectOption({
        value: quality,
        title: label,
        detail: quality === props.current ? "default" : "",
      }),
  );

  const choose = (quality: typeof DownloadQuality.Type) => {
    dialog.pop();
    props.onChoose(quality);
  };

  return (
    <Dialog title={props.title} width={downloadsWidth}>
      <SelectList options={options} width={downloadsWidth - 4} rows={8} onChoose={choose} />
    </Dialog>
  );
}

/** The downloads of this device with their progress, and the default quality */
export function DownloadsDialog(props: {
  readonly downloads: typeof Downloads.Service;
  readonly quality: typeof DownloadQuality.Type;
  readonly setQuality: (quality: typeof DownloadQuality.Type) => void;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
}) {
  const dialog = useDialog();
  const [state, setState] = useState(() => SubscriptionRef.getUnsafe(props.downloads.state));
  const [quality, setQuality] = useState(props.quality);

  useEffect(() => {
    const following = props.run(
      Stream.runForEach(SubscriptionRef.changes(props.downloads.state), (next) =>
        Effect.sync(() => setState(next)),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(following));
    };
  }, []);

  const qualityLabel = downloadQualities.find(([value]) => value === quality)?.[1] ?? quality;
  const pinDetail = (pin: DownloadPin) => {
    const progress = pinProgress(state, pin);
    const failed = progress.failed > 0 ? ` · ${progress.failed} failed` : "";
    if (progress.done === progress.total) return `${megabytes(progress.bytes)}${failed}`;
    const active = progress.downloading ? "↓ " : "";
    return `${active}${progress.done}/${progress.total}${failed}`;
  };

  const options = [
    new SelectOption<DownloadPin | null>({
      value: null,
      title: "Default quality",
      detail: qualityLabel,
    }),
    ...state.pins.map(
      (pin) =>
        new SelectOption<DownloadPin | null>({
          value: pin,
          title: pin.title,
          detail: pinDetail(pin),
        }),
    ),
  ];

  const choose = (pin: DownloadPin | null) => {
    if (pin === null) {
      dialog.push(
        <QualityDialog
          title="Default quality"
          current={quality}
          onChoose={(chosen) => {
            setQuality(chosen);
            props.setQuality(chosen);
          }}
        />,
      );
      return;
    }

    dialog.push(
      <ActionsDialog
        title={pin.title}
        actions={[
          new Action({
            command: commands.removeDownload,
            label: "Remove download",
            run: () => props.run(props.downloads.unpin(pin.kind, pin.id)),
          }),
        ]}
      />,
    );
  };

  return (
    <Dialog title="Downloads" width={downloadsWidth}>
      <SelectList options={options} width={downloadsWidth - 4} rows={14} onChoose={choose} />
    </Dialog>
  );
}

/** "Download" or "Remove download" of a song, an album or a playlist */
export function useDownloadAction(app: ActionApp) {
  const dialog = useDialog();
  const toast = useToast();

  return (
    target: Pick<DownloadPin, "kind" | "id" | "title" | "sourceIds">,
    add: Command,
    remove: Command,
  ) => {
    const downloads = app.downloads;
    if (downloads === null) return [];

    const noun = target.kind === "song" ? "" : ` ${target.kind}`;
    const pinned = SubscriptionRef.getUnsafe(downloads.state).pins.some(
      (pin) => pin.kind === target.kind && pin.id === target.id,
    );
    if (pinned) {
      return [
        new Action({
          command: remove,
          label: `Remove${noun} download`,
          run: () => {
            app.run(downloads.unpin(target.kind, target.id));
            toast("notice", `Removed the download of ${target.title}`);
          },
        }),
      ];
    }

    const download = (quality: typeof DownloadQuality.Type) => {
      app.run(downloads.pin(new DownloadPin({ ...target, quality })));
      toast("notice", `Downloading ${target.title}`);
    };
    return [
      new Action({
        command: add,
        label: `Download${noun}`,
        run: () =>
          dialog.push(
            <QualityDialog
              title={`Download ${target.title}`}
              current={app.downloadQuality}
              onChoose={download}
            />,
          ),
      }),
    ];
  };
}

// The download of an album reads its songs when it runs online
export function useDownloadActions(app: ActionApp) {
  const download = useDownloadAction(app);
  return (item: ActionItem) => {
    if (item instanceof SongItem) {
      const { source } = item;
      const song = { kind: "song" as const, id: source.id, title: titleOf(source) };
      return download(
        { ...song, sourceIds: [source.id] },
        commands.download,
        commands.removeDownload,
      );
    }
    if (item instanceof AlbumItem) {
      const { album } = item;
      return download(
        { kind: "album", id: album.ref, title: album.title, sourceIds: [] },
        commands.downloadAll,
        commands.removeAllDownload,
      );
    }
    return [];
  };
}
