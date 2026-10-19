import { hostname } from "node:os";

import { nodeDatabaseLayer } from "@dyad/db/node";
import { HttpUrl, UserId } from "@dyad/domain";
import { ServerConfig, replicaLayer } from "@dyad/host";
import { createDevice, joinWorkspace } from "@dyad/server-core";
import { Console, Crypto, Effect, FileSystem, Layer, Path } from "effect";
import { Argument, Command } from "effect/cli";
import { Hex } from "effect/encoding";

import { localReplica } from "../context/replica.ts";
import { fail } from "./auth.ts";
import { saveDeviceToken } from "./devices.ts";

const failures = {
  has_users: "This device already joined. Delete its replica folder to join again.",
  invalid_code: "The code is wrong or expired",
  workspace_mismatch: "The replicas are in different workspaces",
  same_server: "The code is from this device",
  unreachable: "Cannot reach the other replica",
  upgrade_required: "The replicas have different versions. Update both.",
  not_admin: "Only an admin can pair",
  not_found: "The other replica does not know this device",
};

const join = Command.make(
  "join",
  {
    url: Argument.String("url").pipe(
      Argument.withSchema(HttpUrl),
      Argument.withDescription(
        "The URL of a replica of the workspace, for example the home server",
      ),
    ),
    code: Argument.String("code").pipe(
      Argument.withDescription("A code from `dyad server code` on that replica"),
    ),
  },
  ({ url, code }) =>
    Effect.gen(function* () {
      const replica = yield* localReplica;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      yield* fs.makeDirectory(replica.dataDirectory, { recursive: true });

      // This device signs in with a device token, so the password of the copied admin is never used
      const password = Hex.encode(yield* crypto.randomBytes(32));
      const session = yield* Effect.gen(function* () {
        const link = yield* joinWorkspace({ url, code, password });
        return yield* createDevice(UserId.make(link.admin.id), hostname());
      }).pipe(
        Effect.provide(nodeDatabaseLayer(path.join(replica.dataDirectory, "replica.sqlite"))),
      );
      yield* saveDeviceToken(replica.origin, session.token);
      yield* Console.log("Joined. This device now keeps its own replica of the library.");
    }).pipe(Effect.catchTag("JoinFailed", (error) => fail(failures[error.reason]))),
).pipe(Command.withDescription("Make this device a replica of the workspace of another replica"));

const run = Command.make("run", {}, () =>
  Effect.gen(function* () {
    const replica = yield* localReplica;
    return yield* Layer.launch(
      replicaLayer(Layer.empty).pipe(
        Layer.provide(
          ServerConfig.configLayer({
            appEnv: "production",
            // The rooms of this device play here, so no other device needs to reach it
            host: "127.0.0.1",
            port: replica.port,
            allowedOrigins: [],
            dataDirectory: replica.dataDirectory,
            mediaCacheBytes: 2 * 1024 * 1024 * 1024,
            device: true,
          }),
        ),
      ),
    );
  }),
).pipe(Command.withDescription("Run the replica of this device in the foreground"));

export const replicaCommand = Command.make("replica").pipe(
  Command.withDescription("The replica of this device"),
  Command.withSubcommands([join, run]),
);
