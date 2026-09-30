import { useAtomValue } from "@effect/atom-react";
import * as stylex from "@stylexjs/stylex";
import { createFileRoute } from "@tanstack/react-router";
import { AsyncResult } from "effect/unstable/reactivity";

import { serverDescriptor, workerDescriptor } from "../state/core.ts";

export const Route = createFileRoute("/")({ ssr: false, component: Scaffold });

function Scaffold() {
  const worker = useAtomValue(workerDescriptor);
  const server = useAtomValue(serverDescriptor);
  const descriptor = AsyncResult.isSuccess(server) ? server.value : null;
  const workerInfo = AsyncResult.isSuccess(worker) ? worker.value : null;

  return (
    <main {...stylex.props(styles.page)}>
      <p {...stylex.props(styles.label)}>DEVELOPMENT SCAFFOLD</p>
      <h1 {...stylex.props(styles.title)}>Dyad</h1>
      <p {...stylex.props(styles.description)}>A local-first music library. Foundation only.</p>
      <dl {...stylex.props(styles.status)} aria-live="polite">
        <dt>Browser worker</dt>
        <dd>
          {AsyncResult.isSuccess(worker)
            ? "Running"
            : AsyncResult.isFailure(worker)
              ? "Unavailable"
              : "Starting"}
        </dd>
        <dt>Browser context</dt>
        <dd>
          {workerInfo === null
            ? "Not checked yet"
            : workerInfo.secureContext
              ? "Secure"
              : "HTTP: HTTPS required for audio and offline storage"}
        </dd>
        <dt>Server connection</dt>
        <dd>
          {descriptor !== null
            ? "Connected"
            : AsyncResult.isFailure(worker)
              ? "Not checked: worker unavailable"
              : AsyncResult.isInitial(server)
                ? "Not checked yet"
                : "Unavailable"}
        </dd>
        <dt>Server replica</dt>
        <dd>{descriptor?.replicaId ?? "Not available"}</dd>
        <dt>Server workspace</dt>
        <dd>{descriptor?.workspaceId ?? "Not available"}</dd>
      </dl>
      <p {...stylex.props(styles.description)}>
        Playback, provider integrations, browser database persistence, and replica sync are not
        implemented yet.
      </p>
    </main>
  );
}

const styles = stylex.create({
  page: { maxWidth: 760, padding: "clamp(24px, 6vw, 64px)", margin: "40px auto" },
  label: { color: "#d6ee9b", fontSize: 11, letterSpacing: "0.12em" },
  title: { fontSize: 48, fontWeight: 600, letterSpacing: "-0.04em", marginBlock: 20 },
  description: { color: "#a1af9c", lineHeight: 1.7 },
  status: {
    display: "grid",
    gridTemplateColumns: { default: "160px minmax(0, 1fr)", "@media (max-width: 500px)": "1fr" },
    gap: 16,
    marginBlock: 32,
  },
});
