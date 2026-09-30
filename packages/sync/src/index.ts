import { RecordingId, ReplicaId, WorkspaceId } from "@dyad/domain";
import { Schema } from "effect";

export const HybridLogicalClock = Schema.Struct({
  wallTime: Schema.Natural,
  counter: Schema.Natural,
});

export const FavoriteSetOperation = Schema.Struct({
  type: Schema.Literal("favorite.set"),
  schemaVersion: Schema.Literal(1),
  workspaceId: WorkspaceId,
  replicaId: ReplicaId,
  sequence: Schema.Int.check(Schema.isGreaterThan(0)),
  hlc: HybridLogicalClock,
  userId: Schema.String.check(Schema.isUUID()),
  recordingId: RecordingId,
  favorite: Schema.Boolean,
});
export type FavoriteSetOperation = typeof FavoriteSetOperation.Type;
