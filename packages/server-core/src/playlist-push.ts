import { credential, playlist, providerAccount } from "@dyad/db";
import { Database } from "@dyad/db/node";
import { and, eq, sql } from "drizzle-orm";
import { Clock, Effect, Schema } from "effect";

import { Jobs } from "./jobs.ts";

export const playlistPushKind = "playlist.push";

export const PlaylistPushPayload = Schema.Struct({ playlistId: Schema.String });

// The wait collects the edits of a few seconds into one write
const pushDelayMs = 3000;

/** Sends the edits of a playlist with a two-way link to its provider, in the library job queue */
export const queuePlaylistPush = (playlistId: string) =>
  Effect.gen(function* () {
    const jobs = yield* Jobs;
    const now = yield* Clock.currentTimeMillis;
    yield* jobs.enqueue(playlistPushKind, playlistId, { playlistId }, { runAt: now + pushDelayMs });
  });

/**
 * Queues the push of a playlist with a two-way link, if this replica has the credential of its
 * account. Edits on other replicas arrive as rows and push from here.
 */
export const pushIfHeld = (playlistId: string) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const [held] = yield* db
      .select({ id: playlist.id })
      .from(playlist)
      .innerJoin(
        providerAccount,
        eq(providerAccount.provider, sql`json_extract(${playlist.link}, '$.provider')`),
      )
      .innerJoin(credential, eq(credential.providerAccountId, providerAccount.id))
      .where(
        and(
          eq(playlist.id, playlistId),
          sql`json_extract(${playlist.link}, '$.direction') = 'two-way'`,
        ),
      );
    if (held !== undefined) yield* queuePlaylistPush(playlistId);
  });
