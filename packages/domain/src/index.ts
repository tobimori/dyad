import { Schema } from "effect";
import { Rpc, RpcGroup } from "effect/unstable/rpc";

export const ReplicaId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("ReplicaId"));
export type ReplicaId = typeof ReplicaId.Type;

export const WorkspaceId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("WorkspaceId"));
export type WorkspaceId = typeof WorkspaceId.Type;

export const RecordingId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand("RecordingId"));
export type RecordingId = typeof RecordingId.Type;

export const ServerDescriptor = Schema.Struct({
  replicaId: ReplicaId,
  workspaceId: WorkspaceId,
  protocolVersion: Schema.Literal(1),
  capabilities: Schema.Struct({
    replication: Schema.Boolean,
    playback: Schema.Boolean,
    providerSync: Schema.Boolean,
  }),
});
export type ServerDescriptor = typeof ServerDescriptor.Type;

export class ServerRpc extends RpcGroup.make(Rpc.make("describe", { success: ServerDescriptor })) {}

export const WorkerDescriptor = Schema.Struct({
  execution: Schema.Literal("worker"),
  secureContext: Schema.Boolean,
  persistentStorageAvailable: Schema.Boolean,
});
export type WorkerDescriptor = typeof WorkerDescriptor.Type;

export class CoreWorkerRpc extends RpcGroup.make(
  Rpc.make("describe", { success: WorkerDescriptor }),
  Rpc.make("server", { success: Schema.NullOr(ServerDescriptor) }),
) {}
