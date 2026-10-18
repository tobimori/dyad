import { recording, source, sourceVariant } from "@dyad/db/client";
import { RecordingId, SourceCopy, SourceSummary, compareCopies } from "@dyad/domain";
import { eq, inArray, or } from "drizzle-orm";
import { Effect, Option } from "effect";

import { ClientDatabase, accountProvidersState } from "./database.ts";
import { localProviderOrder } from "./source-preference.ts";
import { playableSources } from "./views.ts";

/**
 * All sources of the canonical recording of the source that the replica has, in the user's source
 * order. Empty when the replica does not have the source.
 */
export const localSourceCopies = (sourceId: string) =>
  Effect.gen(function* () {
    const db = yield* ClientDatabase;
    const [bound] = yield* db
      .select({ id: recording.id, mergedIntoId: recording.mergedIntoId })
      .from(source)
      .innerJoin(recording, eq(recording.id, source.recordingId))
      .where(eq(source.id, sourceId));
    if (bound === undefined) return [];

    const root = bound.mergedIntoId ?? bound.id;
    const members = yield* db
      .select({ id: recording.id })
      .from(recording)
      .where(or(eq(recording.id, root), eq(recording.mergedIntoId, root)));
    const group = members.map((row) => row.id);

    const playable = new Map(
      (yield* playableSources(inArray(source.recordingId, group))).map((row) => [
        row.summary.id,
        row.summary,
      ]),
    );
    const variants = new Map(
      (yield* db
        .select({ source, variant: sourceVariant })
        .from(source)
        .innerJoin(sourceVariant, eq(sourceVariant.sourceId, source.id))
        .where(inArray(source.recordingId, group))).map((row) => [row.source.id, row]),
    );
    const providers = Option.getOrNull(yield* accountProvidersState.get);
    const names = new Map(Object.entries(providers?.names ?? {}));
    // The same rule as `playableSources`: a provider with an account needs a linked one
    const unavailable = (provider: string) =>
      names.has(provider) ? ("account_required" as const) : ("unavailable" as const);

    const copies = [...variants.values()].map((row) => {
      const usable = playable.get(row.source.id);
      return new SourceCopy({
        // The edition of this copy, which the canonical album can hide
        source:
          usable === undefined
            ? new SourceSummary({
                id: row.source.id,
                provider: row.source.provider,
                title: row.source.rawTitle,
                artist: row.source.rawArtist,
                album: row.source.rawAlbum,
                durationMs: row.source.rawDurationMs,
                codec: row.variant.codec,
                artworkUrl: null,
                artistRef: null,
                albumRef: null,
                explicit: false,
                providerName: names.get(row.source.provider) ?? null,
                recordingId:
                  row.source.recordingId === null ? null : RecordingId.make(row.source.recordingId),
              })
            : new SourceSummary({ ...usable, album: row.source.rawAlbum ?? usable.album }),
        lossless: row.variant.lossless,
        bitrate: row.variant.bitrate,
        sampleRate: row.variant.sampleRate,
        bitDepth: row.variant.bitDepth,
        unavailable: usable === undefined ? unavailable(row.source.provider) : null,
      });
    });

    return copies.toSorted(compareCopies(yield* localProviderOrder));
  }).pipe(Effect.orDie);
