import type { LibraryEntryUnavailable, LibrarySyncStatus } from "@dyad/domain";
import { Data } from "effect";

import { providerName } from "./format.ts";

const unavailableLabels = {
  library_only: "Library only",
  not_in_catalog: "Not in region",
  account_required: "Needs account",
};

export const unavailableLabel = (reason: typeof LibraryEntryUnavailable.Type) =>
  unavailableLabels[reason];

/** Something about the background import that the user must know. Routine runs give none. */
export class LibraryNotice extends Data.Class<{
  readonly provider: string;
  /** `importing`: the first import runs. Lists show it only while they are empty. */
  readonly kind: "relink" | "stale" | "importing";
  readonly text: string;
}> {}

const dayMs = 24 * 60 * 60 * 1000;

// Errors, throttling and incomplete reads are normal for a short time; the next run retries
export const libraryNotices = (
  statuses: ReadonlyArray<LibrarySyncStatus>,
  names: ReadonlyMap<string, string>,
  now: number,
) =>
  statuses.flatMap((status) => {
    const provider = status.provider;
    const name = providerName(names, provider);

    if (status.status === "needs_relink") {
      const text = `Link ${name} again to update your library`;
      return [new LibraryNotice({ provider, kind: "relink", text })];
    }

    if (status.lastCompleteAt === null && (status.running || status.status === "pending")) {
      const text = `Importing your ${name} library…`;
      return [new LibraryNotice({ provider, kind: "importing", text })];
    }

    const failing =
      status.status === "error" ||
      status.status === "throttled" ||
      status.incompleteReason !== null;
    const days =
      status.lastCompleteAt === null ? 0 : Math.floor((now - status.lastCompleteAt) / dayMs);
    if (!failing || days < 1) return [];

    const text = `Your ${name} library has not updated for ${days === 1 ? "1 day" : `${days} days`}`;
    return [new LibraryNotice({ provider, kind: "stale", text })];
  });
