import {
  artist,
  catalogAssertion,
  identifier,
  policyVersion,
  recording,
  songArtist,
} from "@dyad/db";
import { Database } from "@dyad/db/node";
import type { FactRank } from "@dyad/plugin";
import { artistNameKey } from "@dyad/plugin/tracklist";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { Array as Arr, Effect, Option, Schema } from "effect";

import { resolveArtistRoots } from "./artist-matching.ts";
// `assertions.ts` imports this module, so use its exports only inside functions
import { compareAssertions, fields, providerOf, resolveAssertion } from "./assertions.ts";
import type { Assertion } from "./assertions.ts";
import { musicbrainzArtistId, uuidV5 } from "./ids.ts";
import { FactRanks } from "./providers.ts";
import { touchGroups } from "./sync-counter.ts";

// Below the SQLite limit of 32766 parameters
const chunkSize = 500;

/** The `identifier.scheme` of an MBID. Provider artists use the provider ID as the scheme. */
export const mbidScheme = "mbid";

/** `mb:artist:<mbid>` or `<provider>:artist:<external ID>` */
export const artistIdOf = (scheme: string, externalId: string) =>
  scheme === mbidScheme
    ? musicbrainzArtistId(externalId)
    : uuidV5(`${scheme}:artist:${externalId}`);

// The artist IDs of a credit are MBIDs in a MusicBrainz assertion and provider IDs in another
// `plugin` or `parse` one. Other origins give no IDs.
const schemeOf = (assertion: Assertion) => {
  if (assertion.origin !== "plugin" && assertion.origin !== "parse") return null;
  const source = providerOf(assertion);
  return source === "musicbrainz" ? mbidScheme : source;
};

/** Each credit with IDs names artists, also when another origin wins the credit */
export const creditedArtists = (own: ReadonlyArray<Assertion>) =>
  own.flatMap((assertion) => {
    const scheme = schemeOf(assertion);
    if (assertion.field !== "artist_credit" || scheme === null) return [];

    return Option.match(Schema.decodeUnknownOption(fields.artist_credit)(assertion.value), {
      onNone: () => [],
      onSome: (credit) =>
        credit.artists.flatMap((named) =>
          named.id === null ? [] : [{ scheme, externalId: named.id, name: named.name }],
        ),
    });
  });

// The parse decides that an uploading account is the artist, for example a SoundCloud user
const uploaderArtists = (own: ReadonlyArray<Assertion>) => {
  const artistRefs = new Set(
    own.flatMap((assertion) =>
      assertion.field === "uploader_role" && assertion.value === "artist"
        ? [assertion.originRef]
        : [],
    ),
  );
  return own
    .flatMap((assertion) =>
      assertion.field === "uploader" &&
      assertion.origin === "plugin" &&
      artistRefs.has(assertion.originRef)
        ? Option.toArray(Schema.decodeUnknownOption(fields.uploader)(assertion.value)).map(
            (uploader) => ({
              scheme: providerOf(assertion),
              externalId: uploader.id,
              name: uploader.name,
            }),
          )
        : [],
    )
    .toSorted((a, b) => `${a.scheme}:${a.externalId}`.localeCompare(`${b.scheme}:${b.externalId}`));
};

// Credits give the whole text and the names, mostly without join phrases
const joinPhrases = (text: string, names: ReadonlyArray<string>) => {
  const starts: Array<number> = [];
  let end = 0;
  for (const name of names) {
    const start = text.indexOf(name, end);
    starts.push(start);
    if (start !== -1) end = start + name.length;
  }
  return names.map((name, index) => {
    const start = starts[index] ?? -1;
    const next = index === names.length - 1 ? text.length : (starts[index + 1] ?? -1);
    return start === -1 || next === -1 ? "" : text.slice(start + name.length, next);
  });
};

/**
 * The names of the resolved credit of a recording or an edition. A name without an ID links to an
 * uploader with the same name that the parse calls the artist.
 */
export const creditNames = Effect.fn("creditNames")(function* (
  ranks: ReadonlyMap<string, FactRank>,
  own: ReadonlyArray<Assertion>,
) {
  const resolved = resolveAssertion(ranks, own, "artist_credit", fields.artist_credit);
  if (resolved === null) return [];

  const scheme = schemeOf(resolved.assertion);
  const uploaders = uploaderArtists(own);
  const credit = resolved.value;
  const parts =
    credit.artists.length === 0
      ? [{ id: null, name: credit.name, joinPhrase: undefined }]
      : credit.artists;
  const phrases = joinPhrases(
    credit.name,
    parts.map((part) => part.name),
  );

  return yield* Effect.forEach(parts, (part, position) =>
    Effect.gen(function* () {
      const key = artistNameKey(part.name);
      const uploader = uploaders.find((found) => key !== "" && artistNameKey(found.name) === key);
      const linked =
        part.id !== null && scheme !== null ? { scheme, externalId: part.id } : (uploader ?? null);
      return {
        position,
        artistId: linked === null ? null : yield* artistIdOf(linked.scheme, linked.externalId),
        name: part.name,
        joinPhrase: part.joinPhrase ?? phrases[position] ?? "",
      };
    }),
  );
});

/** Whether two lists of credited names are the same */
export const sameNames = (
  a: ReadonlyArray<{
    readonly artistId: string | null;
    readonly name: string;
    readonly joinPhrase: string;
  }>,
  b: ReadonlyArray<{
    readonly artistId: string | null;
    readonly name: string;
    readonly joinPhrase: string;
  }>,
) =>
  a.length === b.length &&
  a.every(
    (name, index) =>
      name.artistId === b[index]?.artistId &&
      name.name === b[index]?.name &&
      name.joinPhrase === b[index]?.joinPhrase,
  );

const NameMention = Schema.Struct({
  id: Schema.String,
  externalId: Schema.String,
  name: Schema.String,
});

// The names that credits and uploaders give each external ID
const mentionsOf = Effect.fn(function* (externalIds: ReadonlyArray<string>) {
  const db = yield* Database;
  const chunks = yield* Effect.forEach(Arr.chunksOf(externalIds, chunkSize), (chunk) =>
    Effect.gen(function* () {
      const list = sql.join(
        chunk.map((id) => sql`${id}`),
        sql`, `,
      );
      const credits = yield* db.all(sql`
          SELECT a.id AS id, json_extract(j.value, '$.id') AS externalId,
            json_extract(j.value, '$.name') AS name
          FROM ${catalogAssertion} AS a, json_each(a.value, '$.artists') AS j
          WHERE a.entity_type IN ('recording', 'edition') AND a.field = 'artist_credit'
            AND a.retracted = 0
            AND json_extract(j.value, '$.id') IN (${list})
        `);
      const uploaders = yield* db.all(sql`
          SELECT a.id AS id, json_extract(a.value, '$.id') AS externalId,
            json_extract(a.value, '$.name') AS name
          FROM ${catalogAssertion} AS a
          WHERE a.entity_type = 'recording' AND a.field = 'uploader' AND a.retracted = 0
            AND a.origin = 'plugin' AND json_extract(a.value, '$.id') IN (${list})
        `);
      const decode = Schema.decodeUnknownEffect(Schema.Array(NameMention));
      return {
        credits: yield* decode(credits).pipe(Effect.orDie),
        uploaders: yield* decode(uploaders).pipe(Effect.orDie),
      };
    }),
  );
  const credits = chunks.flatMap((chunk) => chunk.credits);
  const uploaders = chunks.flatMap((chunk) => chunk.uploaders);

  const assertionIds = [...new Set([...credits, ...uploaders].map((mention) => mention.id))];
  const assertions = new Map(
    (yield* Effect.forEach(Arr.chunksOf(assertionIds, chunkSize), (chunk) =>
      db
        .select()
        .from(catalogAssertion)
        .where(inArray(catalogAssertion.id, [...chunk])),
    ))
      .flat()
      .map((row) => [row.id, row]),
  );
  const withAssertion = (mentions: ReadonlyArray<typeof NameMention.Type>) =>
    mentions.flatMap((mention) => {
      const assertion = assertions.get(mention.id);
      return assertion === undefined ? [] : [{ ...mention, assertion }];
    });
  return { credits: withAssertion(credits), uploaders: withAssertion(uploaders) };
});

/**
 * Upserts the artist rows and identifiers of artists with an MBID or a provider ID. The name comes
 * from the credits that name the artist, else from its uploads, in the order of the resolution
 * policy, so that every replica selects the same name.
 */
export const projectArtistRows = Effect.fn("projectArtistRows")(function* (
  keys: ReadonlyArray<{ readonly scheme: string; readonly externalId: string }>,
) {
  const db = yield* Database;
  const ranks = yield* FactRanks;
  const unique = [...new Map(keys.map((key) => [`${key.scheme}:${key.externalId}`, key])).values()];
  if (unique.length === 0) return;

  const rows = yield* Effect.forEach(unique, (key) =>
    artistIdOf(key.scheme, key.externalId).pipe(Effect.map((id) => ({ ...key, id }))),
  );
  for (const chunk of Arr.chunksOf(rows, chunkSize)) {
    yield* db
      .insert(identifier)
      .values(
        chunk.map((row) => ({
          entityType: "artist" as const,
          entityId: row.id,
          scheme: row.scheme,
          value: row.externalId,
        })),
      )
      .onConflictDoNothing();
  }

  const mentions = yield* mentionsOf([...new Set(rows.map((row) => row.externalId))]);
  const compare = compareAssertions(ranks);
  const nameOf = (row: (typeof rows)[number]) => {
    const matching = (list: typeof mentions.credits) =>
      list
        .filter(
          (mention) =>
            mention.externalId === row.externalId && schemeOf(mention.assertion) === row.scheme,
        )
        .toSorted((a, b) => compare(a.assertion, b.assertion))[0]?.name;
    return matching(mentions.credits) ?? matching(mentions.uploaders) ?? null;
  };

  const changed = yield* Effect.forEach(rows, (row) =>
    Effect.gen(function* () {
      const name = nameOf(row);
      const values = {
        name,
        nameKey: name === null ? null : artistNameKey(name) || null,
      };
      const written = yield* db
        .insert(artist)
        .values({
          id: row.id,
          origin: row.scheme === mbidScheme ? "musicbrainz" : "provider",
          ...values,
          policyVersion,
          revision: 0,
        })
        .onConflictDoUpdate({
          target: artist.id,
          set: values,
          setWhere: sql`${artist.name} IS NOT excluded.name OR ${artist.nameKey} IS NOT excluded.name_key`,
        })
        .returning({ id: artist.id });
      return written.map((found) => found.id);
    }),
  );
  // A merge can arrive before the artist row
  yield* resolveArtistRoots(changed.flat());
  yield* touchArtistGroups(changed.flat());
});

/** Sets a new revision on the groups of the recordings whose credits name the artists */
export const touchArtistGroups = Effect.fn("touchArtistGroups")(function* (
  artistIds: ReadonlyArray<string>,
) {
  const db = yield* Database;
  const ids = [...new Set(artistIds)];
  const recordings = yield* Effect.forEach(Arr.chunksOf(ids, chunkSize), (chunk) =>
    db
      .select({ id: recording.id })
      .from(recording)
      .innerJoin(songArtist, eq(songArtist.recordingId, recording.id))
      .where(inArray(songArtist.artistId, [...chunk])),
  );
  yield* touchGroups(recordings.flat().map((row) => row.id));
});

/**
 * Projects the artists of the credits and uploaders of each recording, and its `song_artist` rows
 * from the resolved credit. `own` are the assertions of the recording and of the recordings merged
 * into it. Returns the recordings whose credit changed.
 */
export const projectArtists = Effect.fn("projectArtists")(function* (
  recordings: ReadonlyArray<{ readonly id: string; readonly own: ReadonlyArray<Assertion> }>,
) {
  const db = yield* Database;
  const ranks = yield* FactRanks;
  yield* projectArtistRows(
    recordings.flatMap((row) => [...creditedArtists(row.own), ...uploaderArtists(row.own)]),
  );

  const existing = Arr.groupBy(
    (yield* Effect.forEach(Arr.chunksOf(recordings, chunkSize), (chunk) =>
      db
        .select()
        .from(songArtist)
        .where(
          inArray(
            songArtist.recordingId,
            chunk.map((row) => row.id),
          ),
        )
        .orderBy(songArtist.recordingId, songArtist.position),
    )).flat(),
    (row) => row.recordingId,
  );
  const changed = yield* Effect.forEach(recordings, (row) =>
    Effect.gen(function* () {
      const names = yield* creditNames(ranks, row.own);
      if (sameNames(existing[row.id] ?? [], names)) return [];

      yield* db.delete(songArtist).where(eq(songArtist.recordingId, row.id));
      if (names.length > 0) {
        yield* db
          .insert(songArtist)
          .values(names.map((name) => ({ recordingId: row.id, ...name })));
      }
      return [row.id];
    }),
  );
  return changed.flat();
});

/** Recordings with a credit assertion and no projected credit, for example from before artists */
export const uncreditedRecordings = Effect.gen(function* () {
  const db = yield* Database;
  const rows = yield* db
    .selectDistinct({ id: recording.id })
    .from(catalogAssertion)
    .innerJoin(recording, eq(recording.id, catalogAssertion.entityId))
    .where(
      and(
        eq(catalogAssertion.entityType, "recording"),
        eq(catalogAssertion.field, "artist_credit"),
        eq(catalogAssertion.retracted, false),
        isNotNull(catalogAssertion.value),
        sql`NOT EXISTS (SELECT 1 FROM ${songArtist} WHERE ${songArtist.recordingId} = ${recording.id})`,
      ),
    );
  return rows.map((row) => row.id);
});
