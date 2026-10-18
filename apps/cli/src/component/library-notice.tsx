import { libraryNotices } from "@dyad/client-runtime";
import type { ServerAtoms } from "@dyad/client-runtime";
import { useAtomValue } from "@effect/atom-react";
import { Clock, Effect } from "effect";
import { AsyncResult } from "effect/reactivity";
import { Fragment, useMemo } from "react";

import { useTheme } from "../theme/theme.ts";

const noNames: ReadonlyMap<string, string> = new Map();

/**
 * Provider display names, the notices of the background library import, and which scopes the
 * replica still syncs
 */
export function useLibraryStatus(atoms: ServerAtoms) {
  const namesResult = useAtomValue(atoms.providerNames);
  const statusResult = useAtomValue(atoms.librarySyncStatus);
  const progressResult = useAtomValue(atoms.syncProgress);
  const names = AsyncResult.isSuccess(namesResult) ? namesResult.value : noNames;
  const statuses = AsyncResult.isSuccess(statusResult) ? statusResult.value : [];

  const notices = useMemo(
    () => libraryNotices(statuses, names, Effect.runSync(Clock.currentTimeMillis)),
    [statuses, names],
  );

  return {
    names,
    progress: AsyncResult.isSuccess(progressResult) ? progressResult.value : null,
    importing: notices.find((notice) => notice.kind === "importing")?.text ?? null,
    notices: notices.filter((notice) => notice.kind !== "importing"),
  };
}

/** One quiet line; a relink names the command of the account flow */
export function LibraryNotices(props: {
  readonly notices: ReturnType<typeof useLibraryStatus>["notices"];
  /** The list is not complete until the replica ends its first load */
  readonly syncing: boolean;
}) {
  const theme = useTheme();
  if (props.notices.length === 0 && !props.syncing) return null;

  return (
    <text wrapMode="none" paddingX={1} flexShrink={0}>
      {props.syncing && <span fg={theme.muted}>Syncing…</span>}
      {props.notices.map((notice, index) => (
        <Fragment key={notice.provider}>
          <span
            fg={theme.muted}
          >{`${index === 0 && !props.syncing ? "" : "  ·  "}${notice.text}`}</span>
          {notice.kind === "relink" && (
            <span fg={theme.accent}>{`  dyad link ${notice.provider}`}</span>
          )}
        </Fragment>
      ))}
    </text>
  );
}
