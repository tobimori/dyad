import { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import { useAtomRefresh, useAtomValue } from "@effect/atom-react";
import type { Audio } from "@opentui/core";
import { useKeyboard, useRenderer } from "@opentui/react";
import { Effect, Fiber, Stream } from "effect";
import { FetchHttpClient } from "effect/http";
import { AsyncResult } from "effect/reactivity";
import { useRef, useState } from "react";

import { playSource } from "./player.ts";
import type { ServerAtoms } from "./state.ts";

const help = {
  library: "enter play · space pause · n next · / search · r retry · q quit",
  "search-input": "type to search · enter go to results · escape library",
  "search-results":
    "enter play · space pause · n next · / edit search · escape library · r retry · q quit",
};

const formatDuration = (milliseconds: number | null) => {
  if (milliseconds === null) return "";
  const seconds = Math.round(milliseconds / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
};

// The contract has no display name for a provider, so `apple_music` shows as `Apple Music`
const formatProvider = (provider: string) =>
  provider
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");

const describe = (source: SourceSummary) =>
  [
    source.artist,
    source.album,
    formatDuration(source.durationMs),
    source.codec,
    source.provider === "local" ? null : formatProvider(source.provider),
  ]
    .filter((part) => part !== null && part !== "")
    .join(" · ");

const toOption = (source: SourceSummary) => ({
  name: source.title ?? "Unknown title",
  description: describe(source),
});

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
  const [view, setView] = useState<keyof typeof help>("library");
  const [queue, setQueue] = useState<ReadonlyArray<SourceSummary>>([]);
  const [playing, setPlaying] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<ReadonlyArray<SourceSummary>>([]);
  const [searchStatus, setSearchStatus] = useState<string | null>(null);
  const playback = useRef<Fiber.Fiber<void> | null>(null);
  const searchFiber = useRef<Fiber.Fiber<void> | null>(null);

  const stop = () => {
    if (playback.current !== null) Effect.runFork(Fiber.interrupt(playback.current));
    playback.current = null;
  };

  // The queue keeps the list that playback started from, so `n` stays in it after a new search
  const play = (list: ReadonlyArray<SourceSummary>, index: number) => {
    if (!AsyncResult.isSuccess(connection)) return;
    stop();
    const source = list[index];
    if (source === undefined) {
      setPlaying(null);
      return;
    }

    props.audio.start();
    setPaused(false);
    setQueue(list);
    setPlaying(index);
    setError(null);
    playback.current = Effect.runFork(
      playSource(props.audio, props.serverUrl, source.id).pipe(
        Effect.provideService(ServerConnection, connection.value),
        Effect.provide(FetchHttpClient.layer),
        Effect.matchEffect({
          onSuccess: () => Effect.sync(() => play(list, index + 1)),
          onFailure: () =>
            Effect.sync(() => {
              setPlaying(null);
              setError("Cannot play this file");
            }),
        }),
      ),
    );
  };

  const cancelSearch = () => {
    if (searchFiber.current !== null) Effect.runFork(Fiber.interrupt(searchFiber.current));
    searchFiber.current = null;
  };

  const search = (value: string) => {
    cancelSearch();
    const query = value.trim();
    if (query === "" || !AsyncResult.isSuccess(connection)) {
      setResults([]);
      setSearchStatus(null);
      return;
    }

    const client = connection.value;
    searchFiber.current = Effect.runFork(
      Effect.gen(function* () {
        // The next keystroke interrupts this fiber, so a search starts only after a pause in typing
        yield* Effect.sleep("250 millis");
        setResults([]);
        setSearchStatus("Searching…");

        const count = yield* client.search({ query }).pipe(
          Stream.tap((result) =>
            Effect.sync(() => setResults((previous) => [...previous, result])),
          ),
          Stream.runCount,
        );

        setSearchStatus(count === 0 ? "No results" : null);
      }).pipe(Effect.catch(() => Effect.sync(() => setSearchStatus("Cannot search")))),
    );
  };

  const closeSearch = () => {
    cancelSearch();
    setResults([]);
    setSearchStatus(null);
    setView("library");
  };

  // OpenTUI 0.6.6 runs global key handlers before the focused input, so typed text must not reach the commands below
  useKeyboard((key) => {
    if (view !== "library" && key.name === "escape") {
      closeSearch();
      return;
    }
    if (view === "search-input") return;

    if (key.name === "/") setView("search-input");
    if (key.name === "q") {
      stop();
      cancelSearch();
      renderer.destroy();
    }
    if (key.name === "r") {
      retryServer();
      retrySources();
    }
    if (key.name === "n" && playing !== null) play(queue, playing + 1);
    if (key.name === "space" && playing !== null) {
      if (paused) props.audio.start();
      else props.audio.stop();
      setPaused(!paused);
    }
  });

  const current = playing === null ? undefined : queue[playing];
  const status =
    current === undefined
      ? (error ?? "Stopped")
      : `${paused ? "Paused" : "Playing"}: ${current.title ?? "Unknown title"}${current.artist === null ? "" : ` · ${current.artist}`}`;

  const library = AsyncResult.match(sourcesResult, {
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
          options={sources.map(toOption)}
          onSelect={(index) => play(sources, index)}
        />
      ),
  });

  const searchView = (
    <>
      <input
        focused={view === "search-input"}
        placeholder="Search"
        maxLength={200}
        onInput={search}
        onSubmit={() => setView("search-results")}
      />
      {searchStatus !== null && <text fg="#888888">{searchStatus}</text>}
      {results.length > 0 && (
        <select
          focused={view === "search-results"}
          flexGrow={1}
          showScrollIndicator
          options={results.map(toOption)}
          onSelect={(index) => play(results, index)}
        />
      )}
    </>
  );

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
      {view === "library" ? library : searchView}
      <text>{status}</text>
      <text fg="#888888">{help[view]}</text>
    </box>
  );
}
