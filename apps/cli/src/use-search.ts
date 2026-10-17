import { ServerConnection } from "@dyad/client-runtime";
import type { SourceSummary } from "@dyad/domain";
import { Effect, Fiber, Option, Stream } from "effect";
import { useRef, useState } from "react";

/** Search as the user types. A new query cancels the search before it. */
export function useSearch(connection: typeof ServerConnection.Service | null) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<ReadonlyArray<SourceSummary>>([]);
  const [status, setStatus] = useState<string | null>(null);
  const fiber = useRef<Fiber.Fiber<void> | null>(null);

  const cancel = () => {
    if (fiber.current !== null) Effect.runFork(Fiber.interrupt(fiber.current));
    fiber.current = null;
  };

  const search = (value: string) => {
    if (value === query) return;
    cancel();
    setQuery(value);

    const trimmed = value.trim();
    if (trimmed === "" || connection === null) {
      setResults([]);
      setStatus(null);
      return;
    }

    fiber.current = Effect.runFork(
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
      }).pipe(Effect.catch(() => Effect.sync(() => setStatus("Cannot search")))),
    );
  };

  return { query, results, status, search, cancel };
}
