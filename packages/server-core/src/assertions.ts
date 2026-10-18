import { catalogAssertion, recording } from "@dyad/db";
import { Database, ReplicaDatabase } from "@dyad/db/node";
import { CreditedArtist } from "@dyad/plugin";
import type { Provider } from "@dyad/plugin";
import { HlcClock } from "@dyad/sync";
import { and, eq, inArray } from "drizzle-orm";
import { Effect, Option, Schema } from "effect";

import { assertionId } from "./ids.ts";
import { Providers } from "./providers.ts";
import { nextChangeSeq, touchGroups } from "./sync-counter.ts";
import { MashupPart, ParsedTitle, TitleSeries, TitleVersion } from "./version-titles.ts";

const schemaVersion = 1;

const ArtistCredit = Schema.Struct({
  name: Schema.String,
  artists: Schema.Array(
    Schema.Struct({
      // Null for a name that no evidence links to an artist
      id: Schema.NullOr(Schema.String),
      name: Schema.String,
      // Text after the name, for example ` feat. `. Origins that give only `name` omit it.
      joinPhrase: Schema.optionalKey(Schema.String),
    }),
  ),
});

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

const parseVersion = (revision: string | null) => Number(revision?.replace("parse:v", "") ?? 0);

/**
 * One assertion for each field of `values` from one origin. `null` states that the origin has no
 * value. Unchanged assertions write nothing.
 */
export const assertRecording = (
  recordingId: string,
  origin: "local" | "musicbrainz" | "provider" | "match" | "parse",
  originRef: string,
  values: { readonly [F in keyof typeof fields]?: (typeof fields)[F]["Type"] | null },
  details: {
    readonly confidence?: number;
    readonly originRevision?: string;
    readonly evidence?: ParseEvidence;
  } = {},
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const clock = yield* HlcClock;
    const identity = yield* ReplicaDatabase;
    const confidence = details.confidence ?? 1;
    const originRevision = details.originRevision ?? null;
    const evidence = details.evidence ?? null;

    const assertions = yield* Effect.forEach(Object.entries(values), ([field, value]) =>
      assertionId({
        entityType: "recording",
        entityId: recordingId,
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
                entityType: "recording",
                entityId: recordingId,
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

// Resolution policy v1. Users curate local tags. MusicBrainz titles are in the original script, where
// providers localize. `match` and `parse` are guesses, so they only fill fields that others leave.
const originRank = ["admin", "local", "provider", "musicbrainz", "match", "parse"];

type Assertion = typeof catalogAssertion.$inferSelect;

const providerOf = (assertion: Assertion) => assertion.originRef.split(":")[0] ?? "";

// Ties go to the lower provider ID, so that all replicas select the same assertion
const compareAssertions =
  (providers: ReadonlyMap<string, Provider>) => (a: Assertion, b: Assertion) => {
    const priority = (assertion: Assertion) =>
      providers.get(providerOf(assertion))?.metadataPriority ?? 0;
    return (
      originRank.indexOf(a.origin) - originRank.indexOf(b.origin) ||
      (a.origin === "provider" && b.origin === "provider"
        ? priority(b) - priority(a) || providerOf(a).localeCompare(providerOf(b))
        : 0) ||
      b.confidence - a.confidence ||
      b.hlc.localeCompare(a.hlc) ||
      a.id.localeCompare(b.id)
    );
  };

/** An import that has no value lets the next origin apply. Only an admin can clear a field. */
export const resolveField = <A>(
  providers: ReadonlyMap<string, Provider>,
  assertions: ReadonlyArray<Assertion>,
  field: string,
  schema: Schema.Decoder<A>,
) => {
  const candidates = assertions
    .filter((assertion) => assertion.field === field)
    .filter((assertion) => assertion.value !== null || assertion.origin === "admin")
    .toSorted(compareAssertions(providers));

  for (const assertion of candidates) {
    if (assertion.value === null) return null;

    const value = Schema.decodeUnknownOption(schema)(assertion.value);
    if (Option.isSome(value)) return value.value;
  }
  return null;
};

/** The value of `field` of each recording from its own assertions, without its merged recordings */
export const resolvedValues = <F extends keyof typeof fields>(
  recordingIds: ReadonlyArray<string>,
  field: F,
  schema: Schema.Decoder<(typeof fields)[F]["Type"]>,
) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;
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
        providers,
        assertions.filter((assertion) => assertion.entityId === id),
        field,
        schema,
      );
      if (value !== null) values.set(id, value);
    }
    return values;
  });

/**
 * Makes the canonical fields of each recording from the assertions. A root resolves over the
 * assertions of all recordings merged into it; a merged recording keeps its own fields.
 */
export const projectRecordings = (recordingIds: Iterable<string>) =>
  Effect.gen(function* () {
    const db = yield* Database;
    const providers = yield* Providers;
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

    const changed = yield* Effect.forEach(rows, (row) => {
      const members = new Set(membersOf.get(row.id));
      const own = assertions.filter((assertion) => members.has(assertion.entityId));
      const resolved = {
        title: resolveField(providers, own, "title", fields.title),
        artistName:
          resolveField(providers, own, "artist_credit", fields.artist_credit)?.name ?? null,
        album: resolveField(providers, own, "album", fields.album),
        durationMs: resolveField(providers, own, "duration_ms", fields.duration_ms),
        artworkUrl: resolveField(providers, own, "artwork_url", fields.artwork_url),
        explicit: resolveField(providers, own, "explicit", fields.explicit),
      };

      const unchanged =
        row.title === resolved.title &&
        row.artistName === resolved.artistName &&
        row.album === resolved.album &&
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
    yield* touchGroups(changed.flat());
  });
