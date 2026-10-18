import { Crypto, Effect } from "effect";

export const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const fromHex = (value: string) =>
  Uint8Array.from(value.match(/../g) ?? [], (pair) => Number.parseInt(pair, 16));

// Every catalog ID depends on this namespace; it must never change
const namespace = fromHex("5162e6fc8cee458490d95da3fb86a603");

/** RFC 9562 UUID version 5: SHA-1 of the Dyad namespace and `name` */
export const uuidV5 = (name: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const digest = yield* crypto
      .digest("SHA-1", new Uint8Array([...namespace, ...new TextEncoder().encode(name)]))
      .pipe(Effect.orDie);

    // The version (5) is in the high bits of byte 6, and the variant (`10`) in the high bits of byte 8
    const bytes = digest.subarray(0, 16).map((byte, index) => {
      if (index === 6) return (byte & 0x0f) | 0x50;
      if (index === 8) return (byte & 0x3f) | 0x80;
      return byte;
    });

    const digits = hex(bytes);
    return [
      digits.slice(0, 8),
      digits.slice(8, 12),
      digits.slice(12, 16),
      digits.slice(16, 20),
      digits.slice(20),
    ].join("-");
  });

/** The same on every replica, so that replicas that add the same item agree on its ID */
export const sourceId = (provider: string, externalId: string) =>
  uuidV5(`${provider}:${externalId}`);

/** The binding of a source never changes. Matching merges the recording into others. */
export const boundRecordingId = (provider: string, externalId: string) =>
  uuidV5(`${provider}:recording:${externalId}`);

/** A source has one variant until a provider gives several formats of one item */
export const variantId = (source: string) => uuidV5(`${source}:variant`);

/** The provisional recording of all sources with the ISRC, until MusicBrainz knows it */
export const isrcRecordingId = (isrc: string) => uuidV5(`isrc:recording:${isrc}`);

export const musicbrainzRecordingId = (mbid: string) => uuidV5(`mb:recording:${mbid}`);

export const musicbrainzArtistId = (mbid: string) => uuidV5(`mb:artist:${mbid}`);

/** An import from the same origin replaces its earlier assertion */
export const assertionId = (assertion: {
  readonly entityType: string;
  readonly entityId: string;
  readonly field: string;
  readonly origin: string;
  readonly originRef: string;
}) =>
  uuidV5(
    `assertion:${assertion.entityType}:${assertion.entityId}:${assertion.field}:${assertion.origin}:${assertion.originRef}`,
  );

export const mergeId = (merge: {
  readonly entityType: string;
  readonly fromId: string;
  readonly intoId: string;
  readonly origin: string;
}) => uuidV5(`merge:${merge.entityType}:${merge.fromId}:${merge.intoId}:${merge.origin}`);
