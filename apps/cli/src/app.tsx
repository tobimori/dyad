import { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { Audio } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Effect, Fiber } from "effect";
import { FetchHttpClient } from "effect/http";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { playSource } from "./player.ts";
import type { ServerAtoms } from "./state.ts";

const formatDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return "";
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

const describe = (source: SourceSummary) =>
  [source.artist, source.album, formatDuration(source.durationMs), source.codec]
    .filter((part) => part !== null && part !== "")
    .join(" · ");

export function App(props: {
  readonly serverUrl: string;
  readonly atoms: ServerAtoms;
  readonly audio: Audio;
}) {
  const renderer = useRenderer();
  const server = useAtomValue(props.atoms.server);
  const connection = useAtomValue(props.atoms.connection);
  const sourcesResult = useAtomValue(props.atoms.sources);
  const retryServer = useAtomRefresh(props.atoms.server);
  const retrySources = useAtomRefresh(props.atoms.sources);
  const sources = AsyncResult.isSuccess(sourcesResult) ? sourcesResult.value : [];
  const [playing, setPlaying] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const playback = useRef<Fiber.Fiber<void> | null>(null);

  const stop = () => {
    if (playback.current !== null) Effect.runFork(Fiber.interrupt(playback.current));
    playback.current = null;
  };

  const play = (index: number) => {
    if (!AsyncResult.isSuccess(connection)) return;
    stop();
    const source = sources[index];
    if (source === undefined) {
      setPlaying(null);
      return;
    }
    props.audio.start();
    setPaused(false);
    setPlaying(index);
    setError(null);
    playback.current = Effect.runFork(
      playSource(props.audio, props.serverUrl, source.id).pipe(
        Effect.provideService(ServerConnection, connection.value),
        Effect.provide(FetchHttpClient.layer),
        Effect.matchEffect({
          onSuccess: () => Effect.sync(() => play(index + 1)),
          onFailure: () =>
            Effect.sync(() => {
              setPlaying(null);
              setError("Cannot play this file");
            }),
        }),
      ),
    );
  };

  useKeyboard((key) => {
    if (key.name === "q") {
      stop();
      renderer.destroy();
    }
    if (key.name === "r") {
      retryServer();
      retrySources();
    }
    if (key.name === "n" && playing !== null) play(playing + 1);
    if (key.name === "space" && playing !== null) {
      if (paused) props.audio.start();
      else props.audio.stop();
      setPaused(!paused);
    }
  });

  const current = playing === null ? undefined : sources[playing];
  const status =
    current === undefined
      ? (error ?? "Stopped")
      : `${paused ? "Paused" : "Playing"}: ${current.title ?? "Unknown title"}${current.artist === null ? "" : ` · ${current.artist}`}`;

  return (
    <box flexDirection="column" padding={1} gap={1} height="100%">
      <text>
        <strong>Dyad</strong>{" "}
        <span fg="#888888">
          {props.serverUrl} ·{" "}
          {AsyncResult.match(server, {
            onInitial: () => "Connecting",
            onFailure: () => "Unavailable",
            onSuccess: () => "Connected",
          })}
        </span>
      </text>
      {AsyncResult.match(sourcesResult, {
        onInitial: () => <text>Loading library</text>,
        onFailure: () => <text>Cannot load the library</text>,
        onSuccess: () =>
          sources.length === 0 ? (
            <text>No files. Set DYAD_LIBRARY_DIR on the server.</text>
          ) : (
            <select
              focused
              flexGrow={1}
              showScrollIndicator
              options={sources.map((source) => ({
                name: source.title ?? "Unknown title",
                description: describe(source),
              }))}
              onSelect={(index) => play(index)}
            />
          ),
      })}
      <text>{status}</text>
      <text fg="#888888">enter play · space pause · n next · r retry · q quit</text>
    </box>
  );
}
