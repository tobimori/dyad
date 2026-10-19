import { EntryId } from "@dyad/domain";
import type { QueueEntry } from "@dyad/domain";
import { Entry, openRenderer, Span, timelineRate } from "@dyad/player";
import type { DjAnalysis, DjStyle, Loudness, Renderer } from "@dyad/player";
import { OutputError, TimedMedia } from "@dyad/plugin";
import type { TimedOutput } from "@dyad/plugin";
import { Clock, Data, Deferred, Effect, Exit, Fiber, PubSub, Semaphore, Stream } from "effect";

/** Audio of one entry. `@dyad/player` decodes only FLAC and MP3. */
export class RenderInput<E> extends Data.Class<{
  readonly codec: "flac" | "mp3";
  readonly bytes: Stream.Stream<Uint8Array, E>;
  /** Without it, the entry plays 8 dB quieter */
  readonly loudness: Loudness | undefined;
  /** Without it, DJ mode joins the entry by crossfade */
  readonly dj: DjAnalysis | undefined;
}> {}

/** The entry plays from `positionMs` at `atUs`, after a join or at the start of an epoch */
export class EntryStarted extends Data.TaggedClass("EntryStarted")<{
  readonly entryId: EntryId;
  readonly positionMs: number;
  /** Timeline frame */
  readonly frame: number;
  readonly atUs: number;
}> {}

/** The last frame of the queue played. The renderer stops. */
export class Ended extends Data.TaggedClass("Ended")<{ readonly atUs: number }> {}

/** The entry cannot play. If it plays already, the renderer stops. */
export class EntryFailed extends Data.TaggedClass("EntryFailed")<{
  readonly entryId: EntryId;
  readonly cause: unknown;
}> {}

/** A write failed or the device went away. The renderer no longer uses the output. */
export class OutputLost extends Data.TaggedClass("OutputLost")<{
  readonly outputId: string;
  readonly error: OutputError;
}> {}

export type RenderEvent = EntryStarted | Ended | EntryFailed | OutputLost;

export class RenderPosition extends Data.Class<{
  readonly entryId: EntryId;
  /** Not rounded, so that a later `play` starts at the exact frame */
  readonly positionMs: number;
}> {}

/**
 * Renders the queue once, as one 44.1 kHz timeline, for all timed outputs. Each discontinuity
 * starts an epoch: the outputs flush, and the new audio plays after the largest lead.
 */
export class SessionRenderer extends Data.Class<{
  /** Starts an epoch: `entries[0]` plays from `positionMs`, then the others follow */
  readonly play: (entries: ReadonlyArray<QueueEntry>, positionMs: number) => Effect.Effect<void>;
  /**
   * Replaces the queue from the entry that plays now. Sent audio stays if the change does not
   * touch it; else an epoch starts at the current position.
   */
  readonly setQueue: (entries: ReadonlyArray<QueueEntry>) => Effect.Effect<void>;
  /** Flushes the outputs and stops. Gives the position that played last. */
  readonly pause: Effect.Effect<RenderPosition | undefined>;
  /** 0 turns crossfade off */
  readonly setCrossfade: (seconds: number) => Effect.Effect<void>;
  /** `undefined` turns DJ mode off */
  readonly setDj: (style: DjStyle | undefined) => Effect.Effect<void>;
  /** What plays now */
  readonly position: Effect.Effect<RenderPosition | undefined>;
  /** The output gets the next block, so it joins in sync with the others */
  readonly addOutput: (id: string, output: TimedOutput) => Effect.Effect<void>;
  readonly removeOutput: (id: string) => Effect.Effect<void>;
  readonly events: Stream.Stream<RenderEvent>;
}> {}

const blockFrames = 4410;
// Blocks go to the outputs this long before their lead, so that a slow render does not delay them
const aheadUs = 500_000;
// From the command to the play time, in addition to the largest lead
const startUs = 300_000;
// The current entry and the next two load at the same time
const inputWindow = 3;
// Spans stay this long after they are sent, for the position
const spanHistoryFrames = 30 * timelineRate;

// An entry keeps its bytes from a little before the read position to this far after it. A 2 hour
// FLAC set would else hold about 700 MB.
const aheadBytes = 16 * 1024 * 1024;
const behindBytes = 1024 * 1024;
// The kept bytes move to a new buffer only after this many bytes can go
const compactBytes = 4 * 1024 * 1024;

// The track needs bytes that the entry dropped, so the input starts again
class Rewound extends Data.TaggedError("Rewound")<{}> {}

// The bytes of one entry from byte `start` of its file
class ByteWindow {
  bytes = new Uint8Array(1 << 20);
  length = 0;
  start = 0;
  complete = false;
  // `Source.needs` of the track that reads the entry. 0 before a track reads it.
  needs: number | undefined = 0;

  reset() {
    this.bytes = new Uint8Array(1 << 20);
    this.length = 0;
    this.start = 0;
    this.complete = false;
  }

  // Moves the kept bytes to a new buffer when enough can go or when `extra` more bytes do not fit
  compact(extra = 0) {
    const keepFrom =
      this.needs === undefined ? this.start : Math.max(this.start, this.needs - behindBytes);
    const drop = Math.min(this.length, keepFrom - this.start);
    if (drop < compactBytes && this.length + extra <= this.bytes.length) return;
    const kept = this.length - drop;
    const moved = new Uint8Array(Math.max(1 << 20, (kept + extra) * 2));
    moved.set(this.bytes.subarray(drop, this.length));
    this.bytes = moved;
    this.start += drop;
    this.length = kept;
  }

  append(chunk: Uint8Array) {
    this.compact(chunk.length);
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
  }

  // A seek point search that gives no position keeps all bytes
  full() {
    return this.needs !== undefined && this.start + this.length - this.needs > aheadBytes;
  }

  rewound() {
    return this.needs !== undefined && this.needs < this.start;
  }
}

const nowUs = Effect.map(Clock.monotonicTimeNanos, (nanos) => Number(nanos / 1000n));

const sleepUntil = (us: number) =>
  Effect.flatMap(nowUs, (now) => (us > now ? Effect.sleep((us - now) / 1000) : Effect.void));

const framesToMs = (frames: number) => (frames * 1000) / timelineRate;

class Input<E> extends Data.Class<{
  readonly ready: Deferred.Deferred<Entry, E>;
  readonly fiber: Fiber.Fiber<void>;
}> {}

// Timeline frame `frame` plays at `playAtUs`. A player frame plus `offset` is a timeline frame.
class Epoch extends Data.Class<{
  readonly frame: number;
  readonly playAtUs: number;
  readonly offset: number;
}> {}

const playAt = (epoch: Epoch, frame: number) =>
  epoch.playAtUs + ((frame - epoch.frame) * 1_000_000) / timelineRate;

const frameAt = (epoch: Epoch, us: number) =>
  epoch.frame + Math.floor(((us - epoch.playAtUs) * timelineRate) / 1_000_000);

/** `input` gives the audio of an entry. Closing the scope stops the renderer. */
export const openSessionRenderer = Effect.fn("openSessionRenderer")(function* <E, F>(
  input: (entry: QueueEntry) => Effect.Effect<RenderInput<F>, E>,
) {
  const scope = yield* Effect.scope;
  const lock = yield* Semaphore.make(1);
  const locked = lock.withPermits(1);
  const events = yield* PubSub.unbounded<RenderEvent>();
  const outputs = new Map<
    string,
    { readonly output: TimedOutput; readonly watch: Fiber.Fiber<void> }
  >();
  const inputs = new Map<EntryId, Input<E | F>>();
  const resolved = new Map<EntryId, Entry>();

  let queue: ReadonlyArray<QueueEntry> = [];
  let crossfadeSeconds = 0;
  let djStyle: DjStyle | undefined;
  // The next unused timeline frame. Epochs never reuse a frame.
  let timeline = 0;
  // What plays when no epoch has audio on the timeline
  let start: RenderPosition | undefined;

  let fiber: Fiber.Fiber<void> | undefined;
  let player: Renderer | undefined;
  let epoch: Epoch | undefined;
  let spans: Array<Span> = [];
  // The current entry at the last rendered frame
  let rendered: string | undefined;

  const publish = (event: RenderEvent) => PubSub.publish(events, event);
  const indexOf = (id: string | undefined) => queue.findIndex((entry) => String(entry.id) === id);

  const lose = Effect.fnUntraced(function* (id: string, output: TimedOutput, error: OutputError) {
    if (outputs.get(id)?.output !== output) return;
    outputs.delete(id);
    yield* publish(new OutputLost({ outputId: id, error }));
  });

  const eachOutput = (f: (output: TimedOutput) => Effect.Effect<void, OutputError>) =>
    Effect.forEach(
      [...outputs],
      ([id, { output }]) => f(output).pipe(Effect.catch((error) => lose(id, output, error))),
      { concurrency: "unbounded", discard: true },
    );

  const maxLeadUs = () =>
    Math.max(0, ...[...outputs.values()].map(({ output }) => output.leadMs * 1000));

  const positionAt = (us: number) => {
    if (epoch === undefined) return start;
    const frame = frameAt(epoch, us);
    const span = spans.findLast((each) => each.current && each.frame <= frame);
    if (frame < epoch.frame || span === undefined) return start;
    return new RenderPosition({
      entryId: EntryId.make(Number(span.entry)),
      positionMs: framesToMs(span.position + Math.min(frame - span.frame, span.frames)),
    });
  };

  // The resolved entries from the one that the player renders now
  const syncPlayer = Effect.suspend(() => {
    if (player === undefined) return Effect.void;
    const entries: Array<Entry> = [];
    for (const entry of queue.slice(Math.max(0, indexOf(rendered)))) {
      const ready = resolved.get(entry.id);
      if (ready === undefined) break;
      entries.push(ready);
    }
    return player.setQueue(entries);
  });

  const load = Effect.fnUntraced(function* (entry: QueueEntry) {
    const ready = yield* Deferred.make<Entry, E | F>();
    const loading = Effect.gen(function* () {
      const audio = yield* input(entry);
      const window = new ByteWindow();
      const loaded = new Entry({
        id: String(entry.id),
        codec: audio.codec,
        album: entry.source.albumRef ?? undefined,
        bytes: () => window.bytes.subarray(0, window.length),
        start: () => window.start,
        complete: () => window.complete,
        needs: (offset) => {
          window.needs = offset;
        },
        loudness: audio.loudness,
        dj: audio.dj,
      });
      resolved.set(entry.id, loaded);
      yield* Deferred.succeed(ready, loaded);
      yield* locked(syncPlayer);

      const waitWhileFull = Effect.gen(function* () {
        while (window.full()) {
          if (window.rewound()) return yield* new Rewound();
          window.compact();
          yield* Effect.sleep("20 millis");
        }
        if (window.rewound()) return yield* new Rewound();
      });
      const fill = Effect.gen(function* () {
        window.reset();
        yield* Stream.runForEach(audio.bytes, (chunk) =>
          Effect.sync(() => window.append(chunk)).pipe(Effect.andThen(waitWhileFull)),
        );
        window.complete = true;
        while (!window.rewound()) yield* Effect.sleep("50 millis");
        return yield* new Rewound();
      });
      return yield* fill.pipe(
        Effect.catchTag("Rewound", () => Effect.void),
        Effect.forever,
      );
    }).pipe(
      Effect.catch((cause) =>
        Deferred.fail(ready, cause).pipe(
          Effect.andThen(publish(new EntryFailed({ entryId: entry.id, cause }))),
        ),
      ),
      Effect.asVoid,
    );
    inputs.set(entry.id, new Input({ ready, fiber: yield* Effect.forkIn(loading, scope) }));
  });

  // Loads the entries from the one that plays now, and frees the others. The entry before it
  // can still fade out.
  const loadWindow = Effect.gen(function* () {
    const audible = positionAt(yield* nowUs);
    const from = Math.max(0, indexOf(String(audible?.entryId)) - 1);
    const wanted = queue.slice(from, Math.max(from, indexOf(rendered)) + inputWindow);
    for (const [id, each] of inputs) {
      if (wanted.some((entry) => entry.id === id)) continue;
      inputs.delete(id);
      resolved.delete(id);
      yield* Fiber.interrupt(each.fiber);
    }
    yield* Effect.forEach(wanted, (entry) => (inputs.has(entry.id) ? Effect.void : load(entry)), {
      discard: true,
    });
  });

  const clearEpoch = () => {
    fiber = undefined;
    player = undefined;
    epoch = undefined;
    spans = [];
    rendered = undefined;
  };

  const stopEpoch = Effect.gen(function* () {
    const running = fiber;
    if (running === undefined) return;
    clearEpoch();
    yield* Fiber.interrupt(running);
    yield* eachOutput((output) => output.flush);
  });

  // Publishes `started` and shows its entry when it becomes audible
  const announce = Effect.fnUntraced(function* (started: EntryStarted) {
    yield* sleepUntil(started.atUs);
    yield* publish(started);
    const entry = queue.find((each) => each.id === started.entryId);
    if (entry === undefined) return;
    const media = new TimedMedia({
      title: entry.source.title,
      artist: entry.source.artist,
      album: entry.source.album,
      artworkUrl: entry.source.artworkUrl,
      startAtUs: started.atUs - started.positionMs * 1000,
      durationMs: entry.source.durationMs,
    });
    yield* Effect.forEach(
      [...outputs.values()],
      ({ output }) =>
        output
          .setMedia(media)
          .pipe(Effect.catch((error) => Effect.logWarning("Timed media failed", error.reason))),
      { concurrency: "unbounded", discard: true },
    );
  });

  const runEpoch = Effect.fnUntraced(
    function* (ready: Deferred.Deferred<Entry, E | F>, positionMs: number) {
      // The loader publishes the failure
      if (Exit.isFailure(yield* Effect.exit(Deferred.await(ready)))) return;

      const current = yield* openRenderer;
      yield* current.setCrossfade(crossfadeSeconds);
      yield* current.setDj(djStyle);
      player = current;
      yield* locked(syncPlayer);
      yield* current.seek(Math.round((positionMs * timelineRate) / 1000));

      // Nothing goes on the timeline before the first frame has its bytes
      let block = yield* current.render(1);
      while (block.waiting) {
        yield* Effect.sleep("20 millis");
        block = yield* current.render(1);
      }
      const at = new Epoch({
        frame: timeline,
        playAtUs: (yield* nowUs) + maxLeadUs() + startUs,
        offset: timeline - block.frame,
      });
      epoch = at;

      let announced: string | undefined;
      let end = at.frame;
      for (;;) {
        const blockFrame = block.frame + at.offset;
        timeline = blockFrame + block.samples.length / 2;
        for (const span of block.spans) {
          const shifted = new Span({ ...span, frame: span.frame + at.offset });
          spans.push(shifted);
          end = Math.max(end, shifted.frame + shifted.frames);
          if (!shifted.current) continue;
          rendered = shifted.entry;
          if (shifted.entry === announced) continue;
          announced = shifted.entry;
          yield* Effect.forkChild(
            announce(
              new EntryStarted({
                entryId: EntryId.make(Number(shifted.entry)),
                positionMs: framesToMs(shifted.position),
                frame: shifted.frame,
                atUs: playAt(at, shifted.frame),
              }),
            ),
          );
        }
        spans = spans.filter((span) => span.frame + span.frames > blockFrame - spanHistoryFrames);
        if (block.waiting) yield* Effect.logWarning("Timed output underrun", { blockFrame });
        yield* locked(loadWindow);

        const blockAt = playAt(at, blockFrame);
        yield* sleepUntil(blockAt - maxLeadUs() - aheadUs);
        const samples = block.samples;
        yield* eachOutput((output) => output.write(blockAt, samples));

        // The block of silence after the end goes out too: a receiver can pad the last audio
        // to its packet size
        const resolving = queue
          .slice(indexOf(rendered) + 1)
          .some((entry) => !resolved.has(entry.id));
        if (block.spans.length === 0 && !block.waiting && !resolving) break;
        block = yield* current.render(blockFrames);
      }

      yield* sleepUntil(playAt(at, end));
      yield* locked(
        Effect.gen(function* () {
          clearEpoch();
          start = undefined;
          yield* eachOutput((output) => output.flush);
          yield* publish(new Ended({ atUs: playAt(at, end) }));
        }),
      );
    },
    (effect) =>
      effect.pipe(
        Effect.scoped,
        Effect.catchTag("EntryError", (error) =>
          locked(
            Effect.gen(function* () {
              start = positionAt(yield* nowUs);
              clearEpoch();
              yield* eachOutput((output) => output.flush);
              yield* publish(
                new EntryFailed({ entryId: EntryId.make(Number(error.entry)), cause: error.cause }),
              );
            }),
          ),
        ),
      ),
  );

  const play = Effect.fnUntraced(function* (
    entries: ReadonlyArray<QueueEntry>,
    positionMs: number,
  ) {
    yield* stopEpoch;
    queue = entries;
    const [first] = entries;
    const position = Math.max(0, positionMs);
    start =
      first === undefined
        ? undefined
        : new RenderPosition({ entryId: first.id, positionMs: position });
    yield* loadWindow;
    const ready = first === undefined ? undefined : inputs.get(first.id)?.ready;
    if (ready === undefined) return;
    fiber = yield* Effect.forkIn(runEpoch(ready, position), scope);
  });

  const setQueue = Effect.fnUntraced(function* (entries: ReadonlyArray<QueueEntry>) {
    const now = yield* nowUs;
    const audible = positionAt(now);
    if (epoch === undefined || audible === undefined) {
      if (fiber === undefined) {
        queue = entries;
        return;
      }
      const from = entries[0]?.id === start?.entryId ? start?.positionMs : undefined;
      return yield* play(entries, from ?? 0);
    }
    if (entries[0]?.id !== audible.entryId) return yield* play(entries, 0);

    // Entries in the sent audio, without the one that fades out before the current one
    const frame = frameAt(epoch, now);
    const from = indexOf(String(audible.entryId));
    const sent = new Set(
      spans
        .filter((span) => span.frame + span.frames > frame && indexOf(span.entry) >= from)
        .map((span) => span.entry),
    );
    if (![...sent].every((id, index) => String(entries[index]?.id) === id)) {
      return yield* play(entries, audible.positionMs);
    }
    queue = entries;
    yield* loadWindow;
    yield* syncPlayer;
  });

  const pause = Effect.gen(function* () {
    const position = positionAt(yield* nowUs);
    yield* stopEpoch;
    start = position;
    return position;
  });

  const setCrossfade = Effect.fnUntraced(function* (seconds: number) {
    crossfadeSeconds = seconds;
    if (player !== undefined) yield* player.setCrossfade(seconds);
  });

  const setDj = Effect.fnUntraced(function* (style: DjStyle | undefined) {
    djStyle = style;
    if (player !== undefined) yield* player.setDj(style);
  });

  const removeOutput = Effect.fnUntraced(function* (id: string) {
    const removed = outputs.get(id);
    if (removed === undefined) return;
    outputs.delete(id);
    yield* Fiber.interrupt(removed.watch);
    yield* removed.output.flush.pipe(Effect.ignore);
  });

  const addOutput = Effect.fnUntraced(function* (id: string, output: TimedOutput) {
    yield* removeOutput(id);
    const watch = yield* output.closed.pipe(
      Effect.as(new OutputError({ reason: "The device closed the connection" })),
      Effect.catch((error) => Effect.succeed(error)),
      Effect.flatMap((error) => lose(id, output, error)),
      Effect.forkIn(scope),
    );
    outputs.set(id, { output, watch });
  });

  return new SessionRenderer({
    play: (entries, positionMs) => locked(play(entries, positionMs)),
    setQueue: (entries) => locked(setQueue(entries)),
    pause: locked(pause),
    setCrossfade: (seconds) => locked(setCrossfade(seconds)),
    setDj: (style) => locked(setDj(style)),
    position: Effect.map(nowUs, positionAt),
    addOutput: (id, output) => locked(addOutput(id, output)),
    removeOutput: (id) => locked(removeOutput(id)),
    events: Stream.fromPubSub(events),
  });
});
