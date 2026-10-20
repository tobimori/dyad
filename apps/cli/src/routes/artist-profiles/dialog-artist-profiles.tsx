import { providerName } from "@dyad/client-runtime";
import type { ArtistProfile } from "@dyad/domain";
import { useAtomValue } from "@effect/atom-react";
import { Effect, Fiber } from "effect";
import { AsyncResult } from "effect/reactivity";
import { useEffect, useState } from "react";

import { Action } from "../../component/dialog-actions.tsx";
import { ArtistItem } from "../../context/action-items.ts";
import type { ActionApp, ActionItem } from "../../context/action-items.ts";
import { commands } from "../../context/keymap.ts";
import { useTheme } from "../../theme/theme.ts";
import { Dialog, useDialog } from "../../ui/dialog.tsx";
import { SelectList, SelectOption } from "../../ui/select-list.tsx";
import { useToast } from "../../ui/toast.tsx";

const dialogWidth = 72;
const noNames: ReadonlyMap<string, string> = new Map();

function ArtistProfilesDialog(props: {
  readonly app: ActionApp;
  readonly artistId: string;
  readonly name: string;
}) {
  const { app } = props;
  const theme = useTheme();
  const toast = useToast();
  const namesResult = useAtomValue(app.atoms.providerNames);
  const names = AsyncResult.isSuccess(namesResult) ? namesResult.value : noNames;
  const [profiles, setProfiles] = useState<ReadonlyArray<ArtistProfile> | null>(null);
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const fiber = app.run(
      app.replica.artistProfiles({ artistId: props.artistId }).pipe(
        Effect.match({
          onSuccess: setProfiles,
          onFailure: () => setProfiles([]),
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [generation]);

  const options = (profiles ?? []).map((profile, index) => {
    const provider =
      profile.scheme === "mbid" ? "MusicBrainz" : providerName(names, profile.scheme);
    const state = profile.artistId === props.artistId ? "main" : null;
    return new SelectOption({
      value: index,
      title: `${provider} · ${profile.name ?? profile.externalId}`,
      detail: state ?? (profile.linked ? "linked" : "unlinked"),
    });
  });

  // An unlinked profile stays in the list, so that it can be linked again
  const choose = (index: number) => {
    const profile = profiles?.[index];
    if (profile === undefined) return;
    if (profile.artistId === props.artistId) {
      toast("notice", "The main profile cannot leave the artist");
      return;
    }
    const decision = profile.linked ? "unlink" : "link";
    app.run(
      app.replica
        .decideArtistLink({ fromId: profile.artistId, intoId: props.artistId, decision })
        .pipe(
          Effect.match({
            onSuccess: () => {
              toast("notice", profile.linked ? "Unlinked the profile" : "Linked the profile again");
              setGeneration((value) => value + 1);
            },
            onFailure: () => toast("error", "Cannot change the link"),
          }),
        ),
    );
  };

  return (
    <Dialog title={`Profiles · ${props.name}`} width={dialogWidth}>
      <SelectList
        options={options}
        width={dialogWidth - 4}
        rows={10}
        empty={profiles === null ? "Loading…" : "No provider profile is known"}
        onChoose={choose}
      />
      <text fg={theme.faint}>
        Enter unlinks a profile that is not this artist, or links it again.
      </text>
    </Dialog>
  );
}

/** The provider profiles that Dyad joined into the artist, to unlink a wrong one */
export function useArtistProfileActions(app: ActionApp) {
  const dialog = useDialog();
  return (item: ActionItem) => {
    if (!(item instanceof ArtistItem) || item.artistId === null) return [];
    const { artistId, name } = item;
    return [
      new Action({
        command: commands.artistProfiles,
        label: "Profiles…",
        run: () => dialog.push(<ArtistProfilesDialog app={app} artistId={artistId} name={name} />),
      }),
    ];
  };
}
