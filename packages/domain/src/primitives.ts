import { Schema } from "effect";

export const ReplicaId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ReplicaId"));
export type ReplicaId = typeof ReplicaId.Type;

export const WorkspaceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const RecordingId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("RecordingId"));
export type RecordingId = typeof RecordingId.Type;

export const UserId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("UserId"));
export type UserId = typeof UserId.Type;

export const DeviceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("DeviceId"));
export type DeviceId = typeof DeviceId.Type;

/** Where the user started a play */
export const PlayContext = Schema.Literals([
  "library",
  "search",
  "history",
  "album",
  "artist",
  "home",
  "playlist",
]);
