import { defineRelations } from "drizzle-orm";

import * as account from "./schema/account.ts";
import * as assertion from "./schema/assertion.ts";
import * as audioAnalysis from "./schema/audio-analysis.ts";
import * as auth from "./schema/auth.ts";
import * as catalog from "./schema/catalog.ts";
import * as download from "./schema/download.ts";
import * as history from "./schema/history.ts";
import * as job from "./schema/job.ts";
import * as librarySync from "./schema/library-sync.ts";
import * as library from "./schema/library.ts";
import * as local from "./schema/local.ts";
import * as matching from "./schema/matching.ts";
import * as providerCache from "./schema/provider-cache.ts";
import * as replica from "./schema/replica.ts";
import * as session from "./schema/session.ts";
import * as source from "./schema/source.ts";
import * as sync from "./schema/sync.ts";

export const schema = {
  ...replica,
  ...auth,
  ...download,
  ...session,
  ...account,
  ...catalog,
  ...assertion,
  ...source,
  ...local,
  ...audioAnalysis,
  ...providerCache,
  ...history,
  ...job,
  ...library,
  ...librarySync,
  ...matching,
  ...sync,
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
    sources: r.many.source(),
    segments: r.many.sourceSegment(),
    identifiers: r.many.identifier({
      from: r.recording.id,
      to: r.identifier.entityId,
      where: { entityType: "recording" },
    }),
  },
  source: {
    recording: r.one.recording({
      from: r.source.recordingId,
      to: r.recording.id,
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
  playlist: {
    entries: r.many.playlistEntry(),
  },
  playlistEntry: {
    playlist: r.one.playlist({
      from: r.playlistEntry.playlistId,
      to: r.playlist.id,
      optional: false,
    }),
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
