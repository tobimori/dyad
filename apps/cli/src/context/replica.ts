import { clientDatabaseLayer, replicaLayer } from "@dyad/client-runtime";
import * as SqliteClient from "@effect/sql-sqlite-node/SqliteClient";
import { Crypto, Effect, FileSystem, Layer, Path, Redacted } from "effect";
import { Hex } from "effect/encoding";
import { Reactivity } from "effect/reactivity";
import envPaths from "env-paths";

/**
 * One file per device token: the server binds a replica to one device, and a new sign-in is a
 * new device
 */
export const replicaFile = (origin: string, token: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const path = yield* Path.Path;
    const key = new TextEncoder().encode(`${origin}\n${Redacted.value(token)}`);
    const digest = yield* crypto.digest("SHA-256", key);
    const name = `${Hex.encode(digest).slice(0, 16)}.db`;
    return path.join(envPaths("dyad", { suffix: "" }).data, "replicas", name);
  });

/** The client replica of the signed-in device, on `node:sqlite` */
export const cliReplicaLayer = (origin: string, token: Redacted.Redacted<string>) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const filename = yield* replicaFile(origin, token);
      yield* fs.makeDirectory(path.dirname(filename), { recursive: true });

      return replicaLayer.pipe(
        Layer.provideMerge(clientDatabaseLayer),
        Layer.provideMerge(SqliteClient.layer({ filename })),
        Layer.provideMerge(Reactivity.layer),
      );
    }),
  );
