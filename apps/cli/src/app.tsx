import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import { useKeyboard, useRenderer } from "@opentui/react";
import { AsyncResult } from "effect/reactivity";

import type { serverDescriptor } from "./state.ts";

export function App(props: {
  readonly serverUrl: string;
  readonly server: ReturnType<typeof serverDescriptor>;
}) {
  const renderer = useRenderer();
  const server = useAtomValue(props.server);
  const retry = useAtomRefresh(props.server);
  const descriptor = AsyncResult.isSuccess(server) ? server.value : null;

  useKeyboard((key) => {
    if (key.name === "q") renderer.destroy();
    if (key.name === "r") retry();
  });

  return (
    <box flexDirection="column" padding={1} gap={1}>
      <text>
        <strong>Dyad</strong>
      </text>
      <box flexDirection="column">
        <text>Server: {props.serverUrl}</text>
        <text>
          Connection:{" "}
          {AsyncResult.match(server, {
            onInitial: () => "Connecting",
            onFailure: () => "Unavailable",
            onSuccess: () => "Connected",
          })}
        </text>
        <text>Replica: {descriptor?.replicaId ?? "Not available"}</text>
        <text>Workspace: {descriptor?.workspaceId ?? "Not available"}</text>
      </box>
      <text fg="#888888">r retry · q quit</text>
    </box>
  );
}
