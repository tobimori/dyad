import { artist, catalogAssertion, entityMerge, identifier, recording } from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { CatalogInputRow } from "@dyad/domain";
import { artistNameKey } from "@dyad/plugin/tracklist";
import { and, eq, inArray, ne, or, sql } from "drizzle-orm";
import { Array as Arr, Effect, Option, Schema } from "effect";

import { artistIdOf, mbidScheme, projectArtistRows, touchArtistGroups } from "./artists.ts";
import { ArtistLinkEvidence, fields, providerOf } from "./assertions.ts";
import { effectiveTarget, followEdges, writeSystemMerge } from "./matching.ts";

// Below the SQLite limit of 32766 parameters
const chunkSize = 500;

const selectChunked = <A, E, R>(
  ids: ReadonlyArray<string>,
  select: (chunk: Array<string>) => Effect.Effect<ReadonlyArray<A>, E, R>,
) =>
  Effect.forEach(Arr.chunksOf(ids, chunkSize), (chunk) => select([...chunk])).pipe(
    Effect.map((rows) => rows.flat()),
  );

const decodeMbid = Schema.decodeUnknownOption(Schema.String);

const CreditMention = Schema.Struct({
  recordingId: Schema.String,
  originRef: Schema.String,
  externalId: Schema.String,
  position: Schema.Int,
  count: Schema.Int,
  name: Schema.String,
});

/**
 * Updates `merged_into_id` and `status` of the artists whose root can change with the edges of
 * `artistIds`, like `resolveRoots` for recordings
 */
export const resolveArtistRoots = (artistIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const start = [...new Set(artistIds)];
    if (start.length === 0) return;

    const current = yield* selectChunked(start, (chunk) =>
      db
        .select({ id: artist.id, mergedIntoId: artist.mergedIntoId })
        .from(artist)
        .where(inArray(artist.id, chunk)),
    );
    const seeds = [...new Set([...start, ...current.flatMap((row) => row.mergedIntoId ?? [])])];
    const members = yield* selectChunked(seeds, (chunk) =>
      db.select({ id: artist.id }).from(artist).where(inArray(artist.mergedIntoId, chunk)),
    );
    const affected = [...new Set([...seeds, ...members.map((row) => row.id)])];

    const rootOf = followEdges((id) =>
      db
        .select()
        .from(entityMerge)
        .where(and(eq(entityMerge.entityType, "artist"), eq(entityMerge.fromId, id)))
        .pipe(Effect.map(effectiveTarget)),
    );

    const rows = yield* selectChunked(affected, (chunk) =>
      db
        .select({ id: artist.id, mergedIntoId: artist.mergedIntoId, status: artist.status })
        .from(artist)
        .where(inArray(artist.id, chunk)),
    );
    const moved = yield* Effect.forEach(rows, (row) =>
      Effect.gen(function* () {
        const root = yield* rootOf(row.id);
        const mergedIntoId = root === row.id ? null : root;
        const status = mergedIntoId === null ? "active" : "merged";
        if (row.mergedIntoId === mergedIntoId && row.status === status) return [];

        yield* db.update(artist).set({ mergedIntoId, status }).where(eq(artist.id, row.id));
        return [row.mergedIntoId ?? row.id, root];
      }),
    );

    // Recordings that credit any member of the earlier or the new root show other refs
    const roots = [...new Set(moved.flat())];
    const family = yield* selectChunked(roots, (chunk) =>
      db
        .select({ id: artist.id })
        .from(artist)
        .where(or(inArray(artist.id, chunk), inArray(artist.mergedIntoId, chunk))),
    );
    yield* touchArtistGroups(family.map((row) => row.id));
  });

// The MusicBrainz artist of a provider artist. A URL relation outranks shared recordings, and
// evidence for two MusicBrainz artists gives no merge.
const decide = (urlMbids: ReadonlySet<string>, sharedMbids: ReadonlySet<string>) => {
  const [url, ...otherUrls] = urlMbids;
  if (url !== undefined) {
    return otherUrls.length === 0
      ? { mbid: url, method: "url_rel" as const, confidence: 0.95 }
      : null;
  }
  const [shared, ...otherShared] = sharedMbids;
  if (shared !== undefined && otherShared.length === 0) {
    return { mbid: shared, method: "shared_recording" as const, confidence: 0.9 };
  }
  return null;
};

/**
 * Writes the `system` merges of provider artists into MusicBrainz artists. Evidence: a MusicBrainz
 * URL relation (an `mbid` assertion), or a recording whose merge group has a MusicBrainz credit
 * with as many artists and the same `artistNameKey` at the same position. Never by name alone.
 */
export const decideArtists = (artistIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const ids = [...new Set(artistIds)];
    if (ids.length === 0) return;

    const providerArtists = yield* selectChunked(ids, (chunk) =>
      db
        .select({
          id: identifier.entityId,
          scheme: identifier.scheme,
          externalId: identifier.value,
        })
        .from(identifier)
        .where(
          and(
            eq(identifier.entityType, "artist"),
            inArray(identifier.entityId, chunk),
            ne(identifier.scheme, mbidScheme),
          ),
        ),
    );
    if (providerArtists.length === 0) return;

    const links = yield* selectChunked(
      providerArtists.map((row) => row.id),
      (chunk) =>
        db
          .select({ artistId: catalogAssertion.entityId, value: catalogAssertion.value })
          .from(catalogAssertion)
          .where(
            and(
              eq(catalogAssertion.entityType, "artist"),
              inArray(catalogAssertion.entityId, chunk),
              eq(catalogAssertion.field, "mbid"),
              eq(catalogAssertion.retracted, false),
            ),
          ),
    );

    const externalIds = [...new Set(providerArtists.map((row) => row.externalId))];
    const mentionRows = yield* selectChunked(externalIds, (chunk) =>
      db.all(sql`
        SELECT a.entity_id AS recordingId, a.origin_ref AS originRef,
          json_extract(j.value, '$.id') AS externalId, CAST(j.key AS INTEGER) AS position,
          json_array_length(a.value, '$.artists') AS count, json_extract(j.value, '$.name') AS name
        FROM ${catalogAssertion} AS a, json_each(a.value, '$.artists') AS j
        WHERE a.entity_type = 'recording' AND a.field = 'artist_credit' AND a.retracted = 0
          AND a.origin = 'provider'
          AND json_extract(j.value, '$.id') IN (${sql.join(
            chunk.map((id) => sql`${id}`),
            sql`, `,
          )})
      `),
    );
    const mentions = yield* Schema.decodeUnknownEffect(Schema.Array(CreditMention))(
      mentionRows,
    ).pipe(Effect.orDie);

    // The MusicBrainz credits in the merge group of each mentioning recording
    const mentioned = [...new Set(mentions.map((mention) => mention.recordingId))];
    const bound = yield* selectChunked(mentioned, (chunk) =>
      db
        .select({
          id: recording.id,
          root: sql<string>`coalesce(${recording.mergedIntoId}, ${recording.id})`,
        })
        .from(recording)
        .where(inArray(recording.id, chunk)),
    );
    const rootOf = new Map(bound.map((row) => [row.id, row.root]));
    const roots = [...new Set(rootOf.values())];
    const groupMembers = yield* selectChunked(roots, (chunk) =>
      db
        .select({
          id: recording.id,
          root: sql<string>`coalesce(${recording.mergedIntoId}, ${recording.id})`,
        })
        .from(recording)
        .where(or(inArray(recording.id, chunk), inArray(recording.mergedIntoId, chunk))),
    );
    const memberRoot = new Map(groupMembers.map((row) => [row.id, row.root]));
    const musicbrainzCredits = yield* selectChunked([...memberRoot.keys()], (chunk) =>
      db
        .select({ recordingId: catalogAssertion.entityId, value: catalogAssertion.value })
        .from(catalogAssertion)
        .where(
          and(
            eq(catalogAssertion.entityType, "recording"),
            inArray(catalogAssertion.entityId, chunk),
            eq(catalogAssertion.field, "artist_credit"),
            eq(catalogAssertion.origin, "musicbrainz"),
            eq(catalogAssertion.retracted, false),
          ),
        ),
    );
    const creditsOfRoot = new Map<string, Array<typeof fields.artist_credit.Type>>();
    for (const row of musicbrainzCredits) {
      const root = memberRoot.get(row.recordingId);
      if (root === undefined) continue;
      for (const credit of Option.toArray(
        Schema.decodeUnknownOption(fields.artist_credit)(row.value),
      )) {
        creditsOfRoot.set(root, [...(creditsOfRoot.get(root) ?? []), credit]);
      }
    }

    const changed = yield* Effect.forEach(providerArtists, (provider) =>
      Effect.gen(function* () {
        const urlMbids = new Set(
          links.flatMap((row) =>
            row.artistId === provider.id ? Option.toArray(decodeMbid(row.value)) : [],
          ),
        );
        const sharedMbids = new Set(
          mentions.flatMap((mention) => {
            const scheme = mention.originRef.split(":")[0];
            const key = artistNameKey(mention.name);
            if (
              mention.externalId !== provider.externalId ||
              scheme !== provider.scheme ||
              key === ""
            ) {
              return [];
            }
            return (creditsOfRoot.get(rootOf.get(mention.recordingId) ?? "") ?? []).flatMap(
              (credit) => {
                const named = credit.artists[mention.position];
                return credit.artists.length === mention.count &&
                  named?.id != null &&
                  artistNameKey(named.name) === key
                  ? [named.id]
                  : [];
              },
            );
          }),
        );

        const decision = decide(urlMbids, sharedMbids);
        const target = decision === null ? null : yield* artistIdOf(mbidScheme, decision.mbid);
        const earlier = yield* db
          .select()
          .from(entityMerge)
          .where(
            and(
              eq(entityMerge.entityType, "artist"),
              eq(entityMerge.fromId, provider.id),
              eq(entityMerge.origin, "system"),
              eq(entityMerge.decision, "merge"),
            ),
          );
        // Only the merges of this rule. A `name_search` merge has other evidence.
        const rejected = yield* Effect.forEach(
          earlier.filter(
            (row) =>
              row.intoId !== target &&
              (row.method === "url_rel" || row.method === "shared_recording"),
          ),
          (row) =>
            writeSystemMerge({
              entityType: "artist",
              fromId: provider.id,
              intoId: row.intoId,
              decision: "reject",
              method: row.method,
              confidence: row.confidence,
              evidence: {},
            }),
        );
        const merged =
          decision === null || target === null
            ? false
            : yield* writeSystemMerge({
                entityType: "artist",
                fromId: provider.id,
                intoId: target,
                decision: "merge",
                method: decision.method,
                confidence: decision.confidence,
                evidence: { mbid: decision.mbid },
              });
        return merged || rejected.includes(true) ? [provider.id] : [];
      }),
    );
    yield* resolveArtistRoots(changed.flat());
  });

// The artists of a `name_search` merge, so that peers know their IDs without a request
const NameSearchEvidence = Schema.Struct({
  fromScheme: Schema.String,
  fromExternalId: Schema.String,
  intoScheme: Schema.String,
  intoExternalId: Schema.String,
});

/**
 * Links each provider artist that a search by the name of the group of `member` found, and that
 * shares songs with the group, to that group. A MusicBrainz root stays the root; two groups with
 * MusicBrainz roots never join. Returns `true` when a group changed.
 */
export const linkFoundArtists = (
  member: { readonly scheme: string; readonly externalId: string },
  found: ReadonlyArray<{
    readonly scheme: string;
    readonly externalId: string;
    readonly shared: number;
  }>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    if (found.length === 0) return false;
    yield* projectArtistRows([member, ...found]);

    const rootOf = (key: { readonly scheme: string; readonly externalId: string }) =>
      Effect.gen(function* () {
        const id = yield* artistIdOf(key.scheme, key.externalId);
        const [row] = yield* db
          .select({ mergedIntoId: artist.mergedIntoId })
          .from(artist)
          .where(eq(artist.id, id));
        const root = row?.mergedIntoId ?? id;
        const [named] = yield* db
          .select({ scheme: identifier.scheme, externalId: identifier.value })
          .from(identifier)
          .where(and(eq(identifier.entityType, "artist"), eq(identifier.entityId, root)));
        return {
          id: root,
          scheme: named?.scheme ?? key.scheme,
          externalId: named?.externalId ?? key.externalId,
        };
      });

    const changed: Array<string> = [];
    for (const candidate of found) {
      const group = yield* rootOf(member);
      const other = yield* rootOf(candidate);
      if (other.id === group.id) continue;
      const [groupMb, otherMb] = [group.scheme === mbidScheme, other.scheme === mbidScheme];
      if (groupMb && otherMb) continue;

      const [from, into] = groupMb ? [other, group] : [group, other];
      const written = yield* writeSystemMerge({
        entityType: "artist",
        fromId: from.id,
        intoId: into.id,
        decision: "merge",
        method: "name_search",
        confidence: 0.85,
        evidence: {
          fromScheme: from.scheme,
          fromExternalId: from.externalId,
          intoScheme: into.scheme,
          intoExternalId: into.externalId,
          sharedSongs: String(candidate.shared),
        },
      });
      if (!written) continue;
      changed.push(from.id);
      yield* resolveArtistRoots([from.id]);
    }
    return changed.length > 0;
  });

/** Decides the provider artists that the credits in the merge groups of the recordings name */
export const matchArtistsOf = (recordingIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const rootsOf = (chunk: Array<string>) =>
      db
        .select({ root: sql`coalesce(${recording.mergedIntoId}, ${recording.id})` })
        .from(recording)
        .where(inArray(recording.id, chunk));
    const ids = [...new Set(recordingIds)];
    if (ids.length === 0) return;

    const members = yield* selectChunked(ids, (chunk) =>
      db
        .select({ id: recording.id })
        .from(recording)
        .where(
          or(
            inArray(recording.id, chunk),
            inArray(recording.id, rootsOf(chunk)),
            inArray(recording.mergedIntoId, rootsOf(chunk)),
          ),
        ),
    );
    const credits = yield* selectChunked(
      members.map((row) => row.id),
      (chunk) =>
        db
          .select()
          .from(catalogAssertion)
          .where(
            and(
              eq(catalogAssertion.entityType, "recording"),
              inArray(catalogAssertion.entityId, chunk),
              eq(catalogAssertion.field, "artist_credit"),
              eq(catalogAssertion.origin, "provider"),
              eq(catalogAssertion.retracted, false),
            ),
          ),
    );
    const artistIds = yield* Effect.forEach(
      credits.flatMap((row) =>
        Option.toArray(Schema.decodeUnknownOption(fields.artist_credit)(row.value)).flatMap(
          (credit) =>
            credit.artists.flatMap((named) =>
              named.id === null ? [] : [{ scheme: providerOf(row), externalId: named.id }],
            ),
        ),
      ),
      (key) => artistIdOf(key.scheme, key.externalId),
    );
    yield* decideArtists(artistIds);
  });

/**
 * Derives the artists of catalog input from a peer: rows for the artists that assertions name, and
 * the roots of artists whose merges changed. The writer decided the merges.
 */
export const deriveArtists = (rows: ReadonlyArray<CatalogInputRow>) =>
  Effect.gen(function* () {
    yield* projectArtistRows(
      rows.flatMap((row) => {
        if (row.table === "entity_merge" && row.method === "name_search") {
          return Option.toArray(
            Schema.decodeUnknownOption(NameSearchEvidence)(row.evidence),
          ).flatMap((link) => [
            { scheme: link.fromScheme, externalId: link.fromExternalId },
            { scheme: link.intoScheme, externalId: link.intoExternalId },
          ]);
        }
        if (row.table !== "catalog_assertion" || row.entityType !== "artist") return [];
        if (row.field === "links") return [{ scheme: mbidScheme, externalId: row.originRef }];
        return Option.toArray(Schema.decodeUnknownOption(ArtistLinkEvidence)(row.evidence)).map(
          (link) => ({
            scheme: link.provider,
            externalId: link.externalId,
          }),
        );
      }),
    );
    yield* resolveArtistRoots(
      rows.flatMap((row) =>
        row.table === "entity_merge" && row.entityType === "artist" ? [row.fromId] : [],
      ),
    );
  });
