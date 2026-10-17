import { RecordingId, ReplicaId, WorkspaceId } from "@dyad/domain";
import { Schema } from "effect";

import { HybridLogicalClock } from "./hlc.ts";

export * from "./hlc.ts";

export class FavoriteSetOperation extends Schema.Class<FavoriteSetOperation>(
  "FavoriteSetOperation",
)({
  type: Schema.Literal("favorite.set"),
  schemaVersion: Schema.Literal(1),
  workspaceId: WorkspaceId,
  replicaId: ReplicaId,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  hlc: HybridLogicalClock,
  userId: Schema.String.check(Schema.isUUID()),
  recordingId: RecordingId,
  favorite: Schema.Boolean,
}) {}
