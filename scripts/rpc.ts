import { ServerConnection, serverConnectionLayer } from "@dyad/client-runtime";
import { ServerRpc } from "@dyad/domain";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, FileSystem, Option, Redacted, Schema, Stream } from "effect";
import { Argument, Command } from "effect/cli";
import type { Rpc } from "effect/rpc";

import { readSandboxFile, serverUrl } from "./sandbox-file.ts";

const methods = Array.from(ServerRpc.requests, ([tag, rpc]) => [tag, { tag, rpc }] as const);

const rpc = Command.make(
  "rpc",
  {
    folder: Argument.Directory("sandbox-folder", { mustExist: true }).pipe(
      Argument.withDescription("The folder that `vp run sandbox` printed"),
    ),
    method: Argument.ChoiceWithValue("method", methods).pipe(
      Argument.withDescription(`One of ${methods.map(([tag]) => tag).join(", ")}`),
    ),
    payload: Argument.String("payload").pipe(
      Argument.withSchema(Schema.fromJsonString(Schema.Unknown)),
      Argument.optional,
      Argument.withDescription('The payload as JSON, for example \'{"query":"tone"}\''),
    ),
  },
  ({ folder, method, payload }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sandbox = yield* readSandboxFile(folder);
      const token = Redacted.make((yield* fs.readFileString(sandbox.tokenFile)).trim());
      const decodedPayload = yield* Schema.decodeUnknownEffect(method.rpc.payloadSchema)(
        Option.getOrUndefined(payload),
      );

      yield* Effect.gen(function* () {
        const connection = yield* ServerConnection;
        // SAFETY: the choice key is a tag of `ServerRpc`
        const tag = method.tag as Rpc.Tag<typeof method.rpc>;
        // SAFETY: the payload was decoded with the schema of the method of `tag`. TypeScript cannot
        // narrow a union of methods by a tag that is only known at run time.
        const call = connection[tag] as (
          payload: typeof decodedPayload,
        ) => ReturnType<(typeof connection)[typeof tag]>;
        const result = call(decodedPayload);

        if (Stream.isStream(result)) {
          // The streaming methods emit different values, and `runForEach` takes one stream type
          const stream: Stream.Stream<unknown, Stream.Error<typeof result>> = result;
          return yield* Stream.runForEach(stream, (element) =>
            Console.log(JSON.stringify(element)),
          );
        }

        const value = yield* result;
        yield* Console.log(JSON.stringify(value ?? null, null, 2));
      }).pipe(
        Effect.provide(serverConnectionLayer(serverUrl(sandbox), Option.some(token))),
        Effect.scoped,
      );
    }),
).pipe(
  Command.withDescription(
    "Call a method of a sandbox server with its device token. Stream methods print one JSON line per element.",
  ),
);

Command.run(rpc, { version: "0.0.0" }).pipe(
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
