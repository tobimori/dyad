import { album, catalogAssertion, edition, editionTrack, recording } from "@dyad/db";
import { Database, ReplicaDatabase } from "@dyad/db/node";
import { CreditedArtist } from "@dyad/plugin";
import type { FactRank } from "@dyad/plugin";
import { HlcClock } from "@dyad/sync";
import { and, eq, inArray, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { Effect, Option, Schema } from "effect";

import type { editionFields } from "./albums.ts";
import { AlbumType, ArtistCredit, ReleaseDate } from "./editions.ts";
import { projectArtists } from "./artists.ts";
import { assertionId } from "./ids.ts";
import { FactRanks } from "./providers.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";
import { MashupPart, ParsedTitle, TitleSeries, TitleVersion } from "./version-titles.ts";

const schemaVersion = 1;

// Stored field names, and the schema of their values
export const fields = {
  title: Schema.String,
  artist_credit: ArtistCredit,
  album: Schema.String,
  duration_ms: Schema.Finite,
  isrc: Schema.String,
  artwork_url: Schema.String,
  explicit: Schema.Boolean,
  uploader: CreditedArtist,
  versions: Schema.Array(TitleVersion),
  mashup_parts: Schema.Array(MashupPart),
  uploader_role: ParsedTitle.fields.uploaderRole,
  set: Schema.Boolean,
  series: TitleSeries,
  album_type: AlbumType,
  release_date: ReleaseDate,
};

/** The input of a parse, so that a new parser version can run without the provider cache */
export class ParseEvidence extends Schema.Class<ParseEvidence>("ParseEvidence")({
  title: Schema.String,
  /** The provider's free-text artist field */
  artist: Schema.NullOr(Schema.String),
  uploader: Schema.NullOr(CreditedArtist),
  artistSource: ParsedTitle.fields.artistSource,
  removed: Schema.Array(Schema.String),
}) {}

/** The provider artist of an `mbid` assertion, so that peers know its ID without a request */
export class ArtistLinkEvidence extends Schema.Class<ArtistLinkEvidence>("ArtistLinkEvidence")({
  url: Schema.String,
  provider: Schema.String,
  externalId: Schema.String,
}) {}

const parseVersion = (revision: string | null) => Number(revision?.replace("parse:v", "") ?? 0);

// One assertion for each field of `values`. Unchanged assertions write nothing.
export const assertFields = Effect.fn("assertFields")(function* (
  entityType: "recording" | "artist" | "edition",
  entityId: string,
  origin: "local" | "plugin" | "match" | "parse",
  originRef: string,
  values:
    | { readonly [F in keyof typeof fields]?: (typeof fields)[F]["Type"] | null }
    | { readonly [F in keyof typeof editionFields]?: (typeof editionFields)[F]["Type"] | null }
    | { readonly links?: ReadonlyArray<string>; readonly mbid?: string | null },
  details: {
    readonly confidence?: number;
    readonly originRevision?: string;
    readonly evidence?: unknown;
  },
) {
  const db = yield* Database;
  const clock = yield* HlcClock;
  const identity = yield* ReplicaDatabase;
  const confidence = details.confidence ?? 1;
  const originRevision = details.originRevision ?? null;
  const evidence = details.evidence ?? null;

  const assertions = yield* Effect.forEach(Object.entries(values), ([field, value]) =>
    assertionId({
      entityType,
      entityId,
      field,
      origin,
      originRef,
    }).pipe(Effect.map((id) => ({ id, field, value }))),
  );
  const known = new Map(
    (yield* db
      .select({
        id: catalogAssertion.id,
        value: catalogAssertion.value,
        confidence: catalogAssertion.confidence,
        originRevision: catalogAssertion.originRevision,
        evidence: catalogAssertion.evidence,
        retracted: catalogAssertion.retracted,
      })
      .from(catalogAssertion)
      .where(
        inArray(
          catalogAssertion.id,
          assertions.map((assertion) => assertion.id),
        ),
      )).map((row) => [row.id, row]),
  );

  const changed = assertions.filter((assertion) => {
    const row = known.get(assertion.id);
    if (row === undefined) return true;
    // A replica with an older parser must not overwrite the parse of a newer one
    if (origin === "parse" && parseVersion(row.originRevision) > parseVersion(originRevision)) {
      return false;
    }
    return (
      row.retracted ||
      JSON.stringify([row.value, row.confidence, row.originRevision, row.evidence]) !==
        JSON.stringify([assertion.value, confidence, originRevision, evidence])
    );
  });

  if (changed.length === 0) return false;

  // Peers pull the rows after a `change_seq`, so the value and the rows commit together
  yield* db.transaction(() =>
    Effect.gen(function* () {
      const changeSeq = yield* nextChangeSeq;
      yield* Effect.forEach(
        changed,
        (assertion) =>
          Effect.gen(function* () {
            const row = {
              id: assertion.id,
              workspaceId: identity.workspaceId,
              entityType,
              entityId,
              field: assertion.field,
              value: assertion.value,
              origin,
              originRef,
              originRevision,
              evidence,
              confidence,
              authorReplicaId: identity.replicaId,
              hlc: yield* clock.next,
              retracted: false,
              schemaVersion,
              changeSeq,
            };
            yield* db
              .insert(catalogAssertion)
              .values(row)
              .onConflictDoUpdate({ target: catalogAssertion.id, set: row });
          }),
        { discard: true },
      );
    }),
  );
  return true;
});

/**
 * One assertion for each field of `values` from one origin. `null` states that the origin has no
 * value. Unchanged assertions write nothing.
 */
export const assertRecording = (
  recordingId: string,
  origin: "local" | "plugin" | "match" | "parse",
  originRef: string,
  values: { readonly [F in keyof typeof fields]?: (typeof fields)[F]["Type"] | null },
  details: {
    readonly confidence?: number;
    readonly originRevision?: string;
    readonly evidence?: ParseEvidence;
  } = {},
) => assertFields("recording", recordingId, origin, originRef, values, details);

/**
 * `links`: the URL relations of a MusicBrainz artist. `mbid`: a MusicBrainz artist links to the
 * provider artist; one assertion per MusicBrainz artist, with the provider ID in the evidence.
 */
export const assertArtist = (
  artistId: string,
  mbid: string,
  values: { readonly links?: ReadonlyArray<string>; readonly mbid?: string | null },
  evidence: ArtistLinkEvidence | null,
) => assertFields("artist", artistId, "plugin", musicbrainzRef(mbid), values, { evidence });

// Resolution policy v2. Users curate local tags. `match` and `parse` are guesses, so they only fill
// fields that others leave.
const originRank = ["admin", "local", "plugin", "match", "parse"];

const rankGroup = (field: string) => {
  if (field === "album_type") return "type";
  if (field === "label") return "label";
  return "metadata";
};

// A later date is often the date of a reissue
const earliestFields = new Set(["date", "release_date"]);

export type Assertion = typeof catalogAssertion.$inferSelect;

/** The fact source of a `plugin` assertion: a provider ID, or `musicbrainz` */
export const providerOf = (assertion: Assertion) => assertion.originRef.split(":")[0] ?? "";

const musicbrainzPrefix = "musicbrainz:";

/** The origin ref of a MusicBrainz fact */
export const musicbrainzRef = (mbid: string) => `${musicbrainzPrefix}${mbid}`;

/** The MBID of the origin ref of a MusicBrainz fact */
export const mbidOfRef = (originRef: string) => originRef.slice(musicbrainzPrefix.length);

// Ties go to the lower plugin ID, so that all replicas select the same assertion
export const compareAssertions =
  (ranks: ReadonlyMap<string, FactRank>) => (a: Assertion, b: Assertion) => {
    const rank = (assertion: Assertion) =>
      ranks.get(providerOf(assertion))?.[rankGroup(assertion.field)] ?? 0;
    const guess = (assertion: Assertion) =>
      assertion.origin === "match" || assertion.origin === "parse";
    const earliest =
      earliestFields.has(a.field) &&
      a.origin !== "admin" &&
      b.origin !== "admin" &&
      !guess(a) &&
      !guess(b)
        ? String(a.value).localeCompare(String(b.value))
        : 0;
    return (
      earliest ||
      originRank.indexOf(a.origin) - originRank.indexOf(b.origin) ||
      (a.origin === "plugin" && b.origin === "plugin"
        ? rank(b) - rank(a) || providerOf(a).localeCompare(providerOf(b))
        : 0) ||
      b.confidence - a.confidence ||
      b.hlc.localeCompare(a.hlc) ||
      a.id.localeCompare(b.id)
    );
  };

/**
 * The selected assertion of `field` and its value. An import that has no value lets the next origin
 * apply. Only the owner can clear a field.
 */
export const resolveAssertion = <A>(
  ranks: ReadonlyMap<string, FactRank>,
  assertions: ReadonlyArray<Assertion>,
  field: string,
  schema: Schema.Decoder<A>,
) => {
  const candidates = assertions
    .filter((assertion) => assertion.field === field)
    .filter((assertion) => assertion.value !== null || assertion.origin === "admin")
    .toSorted(compareAssertions(ranks));

  for (const assertion of candidates) {
    if (assertion.value === null) return null;

    const value = Schema.decodeUnknownOption(schema)(assertion.value);
    if (Option.isSome(value)) return { assertion, value: value.value };
  }
  return null;
};

export const resolveField = <A>(
  ranks: ReadonlyMap<string, FactRank>,
  assertions: ReadonlyArray<Assertion>,
  field: string,
  schema: Schema.Decoder<A>,
) => resolveAssertion(ranks, assertions, field, schema)?.value ?? null;

/** The value of `field` of each recording from its own assertions, without its merged recordings */
export const resolvedValues = Effect.fn("resolvedValues")(function* <F extends keyof typeof fields>(
  recordingIds: ReadonlyArray<string>,
  field: F,
  schema: Schema.Decoder<(typeof fields)[F]["Type"]>,
) {
  const db = yield* Database;
  const ranks = yield* FactRanks;
  const assertions = yield* db
    .select()
    .from(catalogAssertion)
    .where(
      and(
        eq(catalogAssertion.entityType, "recording"),
        inArray(catalogAssertion.entityId, recordingIds),
        eq(catalogAssertion.field, field),
        eq(catalogAssertion.retracted, false),
      ),
    );

  const values = new Map<string, (typeof fields)[F]["Type"]>();
  for (const id of recordingIds) {
    const value = resolveField(
      ranks,
      assertions.filter((assertion) => assertion.entityId === id),
      field,
      schema,
    );
    if (value !== null) values.set(id, value);
  }
  return values;
});

// The album line of a song: an album before an EP and a single, then other types
const albumRank = (type: typeof album.$inferSelect.type) => {
  if (type === "album") return 0;
  if (type === null) return 1;
  if (type === "ep") return 2;
  if (type === "single") return 3;
  return 4;
};

/**
 * Makes the canonical fields of each recording from the assertions. The album and artwork come
 * from the album of the song when an edition has it as a track. A root resolves over the
 * assertions of all recordings merged into it; a merged recording keeps its own fields.
 */
export const projectRecordings = Effect.fn("projectRecordings")(function* (
  recordingIds: Iterable<string>,
) {
  const db = yield* Database;
  const ranks = yield* FactRanks;
  const ids = [...new Set(recordingIds)];
  if (ids.length === 0) return;

  const rows = yield* db.select().from(recording).where(inArray(recording.id, ids));
  const roots = rows.filter((row) => row.mergedIntoId === null).map((row) => row.id);
  const merged = yield* db
    .select({ id: recording.id, root: recording.mergedIntoId })
    .from(recording)
    .where(inArray(recording.mergedIntoId, roots));

  const membersOf = new Map(rows.map((row) => [row.id, [row.id]]));
  for (const member of merged) membersOf.get(member.root ?? "")?.push(member.id);

  const assertions = yield* db
    .select()
    .from(catalogAssertion)
    .where(
      and(
        eq(catalogAssertion.entityType, "recording"),
        inArray(catalogAssertion.entityId, [...ids, ...merged.map((member) => member.id)]),
        eq(catalogAssertion.retracted, false),
      ),
    );

  // The albums that have a member as an edition track
  const rootAlbum = alias(album, "root_album");
  const appearances = yield* db
    .select({
      recordingId: editionTrack.recordingId,
      albumId: rootAlbum.id,
      title: rootAlbum.title,
      type: rootAlbum.type,
      year: rootAlbum.year,
      artworkUrl: rootAlbum.artworkUrl,
    })
    .from(editionTrack)
    .innerJoin(edition, eq(edition.id, editionTrack.editionId))
    .innerJoin(album, eq(album.id, edition.albumId))
    .innerJoin(rootAlbum, eq(rootAlbum.id, sql`coalesce(${album.mergedIntoId}, ${album.id})`))
    .where(inArray(editionTrack.recordingId, [...ids, ...merged.map((member) => member.id)]));

  const changed = yield* Effect.forEach(rows, (row) => {
    const members = new Set(membersOf.get(row.id));
    const own = assertions.filter((assertion) => members.has(assertion.entityId));
    const [shown] = appearances
      .filter((appearance) => members.has(appearance.recordingId) && appearance.title !== null)
      .toSorted(
        (a, b) =>
          albumRank(a.type) - albumRank(b.type) ||
          (a.year ?? Infinity) - (b.year ?? Infinity) ||
          a.albumId.localeCompare(b.albumId),
      );
    const resolved = {
      title: resolveField(ranks, own, "title", fields.title),
      artistName: resolveField(ranks, own, "artist_credit", fields.artist_credit)?.name ?? null,
      album: shown?.title ?? resolveField(ranks, own, "album", fields.album),
      albumId: shown?.albumId ?? null,
      durationMs: resolveField(ranks, own, "duration_ms", fields.duration_ms),
      artworkUrl: shown?.artworkUrl ?? resolveField(ranks, own, "artwork_url", fields.artwork_url),
      explicit: resolveField(ranks, own, "explicit", fields.explicit),
    };

    const unchanged =
      row.title === resolved.title &&
      row.artistName === resolved.artistName &&
      row.album === resolved.album &&
      row.albumId === resolved.albumId &&
      row.durationMs === resolved.durationMs &&
      row.artworkUrl === resolved.artworkUrl &&
      row.explicit === resolved.explicit;
    if (unchanged) return Effect.succeed([]);

    return db
      .update(recording)
      .set(resolved)
      .where(eq(recording.id, row.id))
      .pipe(Effect.as([row.id]));
  });
  const credited = yield* projectArtists(
    rows.map((row) => {
      const members = new Set(membersOf.get(row.id));
      return {
        id: row.id,
        own: assertions.filter((assertion) => members.has(assertion.entityId)),
      };
    }),
  );
  yield* touchGroups([...changed.flat(), ...credited]);
});
