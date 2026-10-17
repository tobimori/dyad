import { defineRelations } from "drizzle-orm";

import * as account from "./schema/account.ts";
import * as assertion from "./schema/assertion.ts";
import * as auth from "./schema/auth.ts";
import * as catalog from "./schema/catalog.ts";
import * as history from "./schema/history.ts";
import * as local from "./schema/local.ts";
import * as providerCache from "./schema/provider-cache.ts";
import * as replica from "./schema/replica.ts";
import * as source from "./schema/source.ts";

export const schema = {
  ...replica,
  ...auth,
  ...account,
  ...catalog,
  ...assertion,
  ...source,
  ...local,
  ...providerCache,
  ...history,
};

export const relations = defineRelations(schema, (r) => ({
  artist: {
    creditNames: r.many.artistCreditName(),
    identifiers: r.many.identifier({
      from: r.artist.id,
      to: r.identifier.entityId,
      where: { entityType: "artist" },
    }),
  },
  artistCredit: {
    names: r.many.artistCreditName(),
    recordings: r.many.recording(),
    releaseGroups: r.many.releaseGroup(),
    releases: r.many.release(),
    tracks: r.many.track(),
  },
  artistCreditName: {
    artistCredit: r.one.artistCredit({
      from: r.artistCreditName.artistCreditId,
      to: r.artistCredit.id,
    }),
    artist: r.one.artist({
      from: r.artistCreditName.artistId,
      to: r.artist.id,
    }),
  },
  recording: {
    artistCredit: r.one.artistCredit({
      from: r.recording.artistCreditId,
      to: r.artistCredit.id,
    }),
    tracks: r.many.track(),
    sources: r.many.source(),
    segments: r.many.sourceSegment(),
    identifiers: r.many.identifier({
      from: r.recording.id,
      to: r.identifier.entityId,
      where: { entityType: "recording" },
    }),
  },
  releaseGroup: {
    artistCredit: r.one.artistCredit({
      from: r.releaseGroup.artistCreditId,
      to: r.artistCredit.id,
    }),
    releases: r.many.release(),
    identifiers: r.many.identifier({
      from: r.releaseGroup.id,
      to: r.identifier.entityId,
      where: { entityType: "release_group" },
    }),
  },
  release: {
    releaseGroup: r.one.releaseGroup({
      from: r.release.releaseGroupId,
      to: r.releaseGroup.id,
    }),
    artistCredit: r.one.artistCredit({
      from: r.release.artistCreditId,
      to: r.artistCredit.id,
    }),
    media: r.many.medium(),
    identifiers: r.many.identifier({
      from: r.release.id,
      to: r.identifier.entityId,
      where: { entityType: "release" },
    }),
  },
  medium: {
    release: r.one.release({
      from: r.medium.releaseId,
      to: r.release.id,
    }),
    tracks: r.many.track(),
  },
  track: {
    medium: r.one.medium({
      from: r.track.mediumId,
      to: r.medium.id,
    }),
    recording: r.one.recording({
      from: r.track.recordingId,
      to: r.recording.id,
    }),
    artistCredit: r.one.artistCredit({
      from: r.track.artistCreditId,
      to: r.artistCredit.id,
    }),
    sources: r.many.source(),
    identifiers: r.many.identifier({
      from: r.track.id,
      to: r.identifier.entityId,
      where: { entityType: "track" },
    }),
  },
  source: {
    recording: r.one.recording({
      from: r.source.recordingId,
      to: r.recording.id,
    }),
    track: r.one.track({
      from: r.source.trackId,
      to: r.track.id,
    }),
    variants: r.many.sourceVariant(),
    segments: r.many.sourceSegment(),
    localFiles: r.many.localFile(),
  },
  sourceVariant: {
    source: r.one.source({
      from: r.sourceVariant.sourceId,
      to: r.source.id,
      optional: false,
    }),
  },
  sourceSegment: {
    source: r.one.source({
      from: r.sourceSegment.sourceId,
      to: r.source.id,
      optional: false,
    }),
    recording: r.one.recording({
      from: r.sourceSegment.recordingId,
      to: r.recording.id,
    }),
  },
  libraryRoot: {
    files: r.many.localFile(),
  },
  localFile: {
    libraryRoot: r.one.libraryRoot({
      from: r.localFile.libraryRootId,
      to: r.libraryRoot.id,
      optional: false,
    }),
    source: r.one.source({
      from: r.localFile.sourceId,
      to: r.source.id,
    }),
  },
}));
