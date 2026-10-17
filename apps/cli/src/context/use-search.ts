import type { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import { Cause, Effect, Fiber, Option, Stream } from "effect";
import { useRef, useState } from "react";

import { describeFailure } from "../log.ts";

/** A new query cancels the search before it */
export function useSearch(props: {
  readonly connection: typeof ServerConnection.Service | null;
  /** Runs an effect with the log file of the CLI */
  readonly run: <A, E>(effect: Effect.Effect<A, E>) => Fiber.Fiber<A, E>;
  readonly onFailure: (message: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<SourceSummary>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const fiber = useRef<Fiber.Fiber<void> | null>(null);

  const cancel = () => {
    if (fiber.current !== null) Effect.runFork(Fiber.interrupt(fiber.current));
    fiber.current = null;
  };

  const failed = (cause: Cause.Cause<unknown>) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("Cannot search", describeFailure(cause));
      setStatus("Cannot search");
      props.onFailure("The search failed. Check the connection and try again.");
    });

  const search = (value: string) => {
    if (value === query) return;
    cancel();
    setQuery(value);

    const trimmed = value.trim();
    const connection = props.connection;
    if (trimmed === "" || connection === null) {
      setResults([]);
      setStatus(null);
      return;
    }

    fiber.current = props.run(
      Effect.gen(function* () {
        // The next keystroke interrupts this fiber, so a search starts only after a pause in typing
        yield* Effect.sleep("250 millis");
        setStatus("Searching…");

        // Each list replaces the previous one; the last list is final
        const last = yield* connection.search({ query: trimmed }).pipe(
          Stream.tap((list) => Effect.sync(() => setResults(list.sources))),
          Stream.runLast,
        );

        const found = Option.isSome(last) && last.value.sources.length > 0;
        setStatus(found ? null : "No results");
      }).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause) ? Effect.void : failed(cause),
        ),
      ),
    );
  };

  return { query, results, status, search, cancel };
}
