import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/rpc";

export const HttpUrl = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === "http:" || url.protocol === "https:"
      ? undefined
      : "Expected an HTTP or HTTPS URL",
  ),
);

export const ReplicaId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ReplicaId"));
export type ReplicaId = typeof ReplicaId.Type;

export const WorkspaceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const RecordingId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("RecordingId"));
export type RecordingId = typeof RecordingId.Type;

export class ServerDescriptor extends Schema.Class<ServerDescriptor>("ServerDescriptor")({
  replicaId: ReplicaId,
  workspaceId: WorkspaceId,
  protocolVersion: Schema.Literal(1),
  capabilities: Schema.Struct({
    replication: Schema.Boolean,
    playback: Schema.Boolean,
    providerSync: Schema.Boolean,
  }),
}) {}

export class ServerRpc extends RpcGroup.make(Rpc.make("describe", { success: ServerDescriptor })) {}

export class WorkerDescriptor extends Schema.Class<WorkerDescriptor>("WorkerDescriptor")({
  execution: Schema.Literal("worker"),
  secureContext: Schema.Boolean,
  persistentStorageAvailable: Schema.Boolean,
}) {}

export class CoreWorkerRpc extends RpcGroup.make(
  Rpc.make("describe", { success: WorkerDescriptor }),
  Rpc.make("server", { success: Schema.NullOr(ServerDescriptor) }),
) {}
