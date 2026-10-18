import { nodeDatabaseLayer } from "@dyad/db/node";
import { HttpUrl } from "@dyad/domain";
import { joinWorkspace } from "@dyad/server-core";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Config, Console, Effect, FileSystem, Layer, Option, Path, Redacted } from "effect";
import { Argument, Command, Prompt } from "effect/cli";

import { ServerConfig } from "./config.ts";

const failures = {
  has_users: "This server already has users. An admin pairs it with `dyad server pair`.",
  invalid_code: "The code is wrong or expired",
  workspace_mismatch: "The servers are in different workspaces",
  same_server: "The code is from this server",
  unreachable: "Cannot reach the other server",
  upgrade_required: "The servers have different versions. Update both.",
  not_admin: "Only an admin can pair servers",
  not_found: "The other server does not know this server",
};

const join = Command.make(
  "join",
  {
    url: Argument.String("url").pipe(
      Argument.withSchema(HttpUrl),
      Argument.withDescription("The URL of a server of the workspace"),
    ),
    code: Argument.String("code").pipe(
      Argument.withDescription("A code from `dyad server code` on that server"),
    ),
  },
  ({ url, code }) =>
    Effect.gen(function* () {
      const { dataDirectory } = yield* ServerConfig;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.makeDirectory(dataDirectory, { recursive: true });

      // For scripts; a person types it
      const fromEnvironment = yield* Config.option(Config.Redacted("DYAD_JOIN_PASSWORD"));
      const password = Option.isSome(fromEnvironment)
        ? fromEnvironment.value
        : yield* Prompt.Password({ message: "Password of your admin on this server" });

      const link = yield* joinWorkspace({ url, code, password: Redacted.value(password) }).pipe(
        Effect.provide(nodeDatabaseLayer(path.join(dataDirectory, "replica.sqlite"))),
      );
      yield* Console.log(
        `Joined the workspace of ${link.replicaId}. Start this server and sign in as ${link.admin.username}.`,
      );
    }).pipe(
      Effect.catchTag("JoinFailed", (error) =>
        Console.error(failures[error.reason]).pipe(
          Effect.andThen(
            Effect.sync(() => {
              process.exitCode = 1;
            }),
          ),
        ),
      ),
    ),
).pipe(
  Command.withDescription(
    "Join the workspace of another server before this server starts for the first time",
  ),
);

Command.run(join, { version: "0.0.0" }).pipe(
  Effect.provide(ServerConfig.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  NodeRuntime.runMain,
);
