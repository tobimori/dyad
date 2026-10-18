import { openSource, readSourceInfo } from "@dyad/audio";
import type { Source, SourceInfo } from "@dyad/audio";
import { Data, Effect, Exit, Scope, Semaphore } from "effect";

import { loudnessGain } from "./loudness.ts";
import type { Loudness } from "./loudness.ts";
import { Resampler } from "./resampler.ts";

/** One queue entry. Its bytes can still arrive while it plays. */
export class Entry extends Data.Class<{
  /** Queue entry ID: the same source twice in a queue has two IDs */
  readonly id: string;
  readonly codec: "flac" | "mp3";
  /** All bytes received so far */
  readonly bytes: () => Uint8Array;
  readonly complete: () => boolean;
  /** Without it, the entry plays 8 dB quieter */
  readonly loudness: Loudness | undefined;
}> {}

export class EntryError extends Data.TaggedError("EntryError")<{
  readonly entry: string;
  readonly cause: unknown;
}> {}

/** Frames of one entry in a block */
export class Span extends Data.Class<{
  readonly entry: string;
  /** Timeline frame of the first frame */
  readonly frame: number;
  readonly frames: number;
  /** Entry position of the first frame, in timeline frames */
  readonly position: number;
}> {}

/** Timeline frames at 44.1 kHz, stereo and interleaved. Frames outside `spans` are silence. */
export class Block extends Data.Class<{
  /** Timeline frame of the first frame */
  readonly frame: number;
  readonly samples: Float32Array;
  readonly spans: ReadonlyArray<Span>;
  /** The current entry waits for bytes, so the block ends in silence */
  readonly waiting: boolean;
}> {}

/** Renders the queue as one gapless stream */
export class Renderer extends Data.Class<{
  /** Entries to play from now on. If the first one plays already, it continues. */
  readonly setQueue: (entries: ReadonlyArray<Entry>) => Effect.Effect<void>;
  /** Continues the current entry at `position` timeline frames */
  readonly seek: (position: number) => Effect.Effect<void>;
  /** Renders the next `frames` timeline frames */
  readonly render: (frames: number) => Effect.Effect<Block, EntryError>;
}> {}

// An entry whose source feeds a run
class Track extends Data.Class<{
  readonly entry: Entry;
  readonly source: Source;
  readonly scope: Scope.Closeable;
  /** Run input frame of the first source frame */
  readonly input: number;
  readonly gain: number;
}> {}

// Entries of one sample rate play through one resampler, so that their joins stay gapless
class Run extends Data.Class<{
  readonly resampler: Resampler;
  /** The last track feeds the resampler */
  readonly tracks: Array<Track>;
}> {}

class Start extends Data.Class<{ readonly entry: Entry; readonly position: number }> {}

const readInfo = (entry: Entry) => {
  const info = readSourceInfo(entry.bytes(), entry.codec);
  if (info === undefined && entry.complete()) {
    return Effect.fail(new EntryError({ entry: entry.id, cause: "The file has no audio header" }));
  }
  return Effect.succeed(info);
};

const openTrack = (entry: Entry, info: SourceInfo, input: number) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const source = yield* openSource(info).pipe(
      Scope.provide(scope),
      Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
      Effect.mapError((cause) => new EntryError({ entry: entry.id, cause })),
    );
    return new Track({ entry, source, scope, input, gain: loudnessGain(entry.loudness) });
  });

/** Closing the scope frees all decoders */
export const openRenderer = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);

  let queue: ReadonlyArray<Entry> = [];
  let run: Run | undefined;
  // Where the next run begins when there is none
  let start: Start | undefined;
  let timeline = 0;

  const closeRun = Effect.gen(function* () {
    const tracks = run?.tracks ?? [];
    run = undefined;
    for (const track of tracks) yield* Scope.close(track.scope, Exit.void);
  });
  yield* Effect.addFinalizer(() => closeRun);

  const trackStart = (current: Run, track: Track) => current.resampler.outputAt(track.input);

  const openRun = (next: Start) =>
    Effect.gen(function* () {
      const info = yield* readInfo(next.entry);
      if (info === undefined) return undefined;

      const resampler = new Resampler(info.sampleRate, next.position);
      const track = yield* openTrack(next.entry, info, 0);
      track.source.seek(resampler.inputEnd);
      return new Run({ resampler, tracks: [track] });
    });

  // Gives false when the run needs bytes that did not arrive yet
  const feed = (current: Run) =>
    Effect.gen(function* () {
      const track = current.tracks.at(-1)!;
      const pcm = yield* track.source
        .read(track.entry.bytes(), track.entry.complete())
        .pipe(Effect.mapError((cause) => new EntryError({ entry: track.entry.id, cause })));

      if (pcm !== undefined) {
        current.resampler.push(pcm.channels, pcm.frames, track.gain);
        return pcm.frames > 0;
      }

      // The source ended: the next entry continues the run if it has the same sample rate
      const next = queue[0];
      if (next === undefined) {
        current.resampler.end();
        return true;
      }
      const info = yield* readInfo(next);
      if (info === undefined) return false;
      if (info.sampleRate !== current.resampler.rate) {
        current.resampler.end();
        return true;
      }

      queue = queue.slice(1);
      current.tracks.push(yield* openTrack(next, info, current.resampler.inputEnd));
      return true;
    });

  // Spans of the output frames from `from`, which the block holds from frame `at`
  const spansOf = (current: Run, from: number, frames: number, at: number) =>
    current.tracks.flatMap((track, index) => {
      const begin = trackStart(current, track);
      const following = current.tracks[index + 1];
      const end =
        following === undefined ? Number.POSITIVE_INFINITY : trackStart(current, following);
      const first = Math.max(from, begin);
      const last = Math.min(from + frames, end);
      if (first >= last) return [];
      return [
        new Span({
          entry: track.entry.id,
          frame: timeline + at + (first - from),
          frames: last - first,
          position: first - begin,
        }),
      ];
    });

  // Frees the decoders of tracks whose output is complete, so that the first track is current
  const dropPlayedTracks = (current: Run) =>
    Effect.gen(function* () {
      while (
        current.tracks.length > 1 &&
        trackStart(current, current.tracks[1]!) <= current.resampler.output
      ) {
        yield* Scope.close(current.tracks.shift()!.scope, Exit.void);
      }
    });

  const setQueue = (entries: ReadonlyArray<Entry>) =>
    Effect.gen(function* () {
      const [first, ...rest] = entries;
      const current = run?.tracks[0];

      if (first === undefined || first.id !== (current?.entry ?? start?.entry)?.id) {
        yield* closeRun;
        start = first === undefined ? undefined : new Start({ entry: first, position: 0 });
        queue = rest;
        return;
      }
      if (run === undefined || current === undefined) {
        queue = rest;
        return;
      }

      // The current entry continues. Entries that the run joined already must stay next.
      const joined = run.tracks.slice(1);
      if (joined.every((track, index) => rest[index]?.id === track.entry.id)) {
        queue = rest.slice(joined.length);
        return;
      }

      const position = run.resampler.output - trackStart(run, current);
      yield* closeRun;
      start = new Start({ entry: current.entry, position });
      queue = rest;
    }).pipe(Semaphore.withPermits(lock, 1));

  const seek = (position: number) =>
    Effect.gen(function* () {
      const tracks = run?.tracks ?? [];
      const entry = tracks[0]?.entry ?? start?.entry;
      if (entry === undefined) return;

      yield* closeRun;
      start = new Start({ entry, position: Math.max(0, position) });
      queue = [...tracks.slice(1).map((track) => track.entry), ...queue];
    }).pipe(Semaphore.withPermits(lock, 1));

  const render = (frames: number) =>
    Effect.gen(function* () {
      const samples = new Float32Array(frames * 2);
      const spans: Array<Span> = [];
      let filled = 0;
      let waiting = false;

      while (filled < frames) {
        if (run === undefined) {
          if (start === undefined && queue[0] !== undefined) {
            start = new Start({ entry: queue[0], position: 0 });
            queue = queue.slice(1);
          }
          if (start === undefined) break;

          run = yield* openRun(start);
          if (run === undefined) {
            waiting = true;
            break;
          }
          start = undefined;
        }

        const from = run.resampler.output;
        const written = run.resampler.pull(samples, filled, frames - filled);
        for (const span of spansOf(run, from, written, filled)) {
          const last = spans.at(-1);
          if (last?.entry === span.entry && last.frame + last.frames === span.frame) {
            spans[spans.length - 1] = new Span({ ...last, frames: last.frames + span.frames });
            continue;
          }
          spans.push(span);
        }
        filled += written;
        yield* dropPlayedTracks(run);
        if (filled === frames) break;

        if (run.resampler.done) {
          yield* closeRun;
          continue;
        }
        if (!(yield* feed(run))) {
          waiting = true;
          break;
        }
      }

      const block = new Block({ frame: timeline, samples, spans, waiting });
      timeline += frames;
      return block;
    }).pipe(Semaphore.withPermits(lock, 1));

  return new Renderer({ setQueue, seek, render });
});
