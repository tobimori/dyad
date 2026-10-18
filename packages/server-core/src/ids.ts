import { uuidV5 } from "@dyad/sync";

export { fromHex, hex, uuidV5 } from "@dyad/sync";

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
