import { openSource, readSourceInfo } from "@dyad/audio";
import type { Source, SourceInfo } from "@dyad/audio";
import { Data, Effect, Exit, Scope, Semaphore } from "effect";

import { entryLevel, peakCeiling } from "./loudness.ts";
import type { Loudness } from "./loudness.ts";
import { Resampler, timelineRate } from "./resampler.ts";

/** One queue entry. Its bytes can still arrive while it plays. */
export class Entry extends Data.Class<{
  /** Queue entry ID: the same source twice in a queue has two IDs */
  readonly id: string;
  readonly codec: "flac" | "mp3";
  /** Adjacent entries of one album join gapless, also with crossfade on */
  readonly album: string | undefined;
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
  /** The entry that plays now. In a crossfade, the next entry is current from the middle on. */
  readonly current: boolean;
}> {}

/**
 * Timeline frames at 44.1 kHz, stereo and interleaved. Frames outside `spans` are silence. In a
 * crossfade, two spans cover the same frames.
 */
export class Block extends Data.Class<{
  /** Timeline frame of the first frame */
  readonly frame: number;
  readonly samples: Float32Array;
  readonly spans: ReadonlyArray<Span>;
  /** The current entry waits for bytes, so the block ends in silence */
  readonly waiting: boolean;
}> {}

/** Renders the queue as one stream with gapless joins or crossfades */
export class Renderer extends Data.Class<{
  /** Entries to play from now on. If the first one is current, it continues. */
  readonly setQueue: (entries: ReadonlyArray<Entry>) => Effect.Effect<void>;
  /** Continues the current entry at `position` timeline frames, without a crossfade */
  readonly seek: (position: number) => Effect.Effect<void>;
  /** 0 turns crossfade off. A crossfade that plays already continues. */
  readonly setCrossfade: (seconds: number) => Effect.Effect<void>;
  /** Renders the next `frames` timeline frames */
  readonly render: (frames: number) => Effect.Effect<Block, EntryError>;
}> {}

/** Crossfade length when the user turns crossfade on */
export const defaultCrossfadeSeconds = 6;

// Fade-out of an entry that a skip or a seek stops while another entry plays
const cutFrames = 0.1 * timelineRate;

// An entry whose source feeds a lane
class Track extends Data.Class<{
  readonly entry: Entry;
  readonly source: Source;
  readonly scope: Scope.Closeable;
  /** Lane input frame of the first source frame */
  readonly input: number;
  readonly gain: number;
  /** True peak after `gain`, as a linear sample value */
  readonly peak: number;
}> {}

// The gain goes along an equal-power curve over `frames` lane output frames from `from`
class Fade extends Data.Class<{ readonly from: number; readonly frames: number }> {}

// Entries of one sample rate play through one resampler, so that their joins stay gapless
class Lane extends Data.Class<{
  readonly resampler: Resampler;
  /** The first track plays now; the last track feeds the resampler */
  readonly tracks: Array<Track>;
  readonly fadeIn: Fade | undefined;
  readonly fadeOut: Fade | undefined;
  /** A skip or a seek stopped the lane, so it only fades out */
  readonly released: boolean;
}> {}

// The next lane. It opens when the head lane reaches output frame `at`, or at once without `at`.
class Start extends Data.Class<{
  readonly entry: Entry;
  readonly position: number;
  readonly at: number | undefined;
  readonly fadeIn: Fade | undefined;
}> {}

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
    return new Track({ entry, source, scope, input, ...entryLevel(entry.loudness) });
  });

const sameAlbum = (a: Entry, b: Entry) => a.album !== undefined && a.album === b.album;

const progress = (fade: Fade, frame: number) =>
  Math.min(1, Math.max(0, (frame - fade.from) / fade.frames));

const middle = (fade: Fade) => Math.ceil(fade.from + fade.frames / 2);

const laneGain = (lane: Lane, frame: number) =>
  (lane.fadeIn === undefined ? 1 : Math.sin((Math.PI / 2) * progress(lane.fadeIn, frame))) *
  (lane.fadeOut === undefined ? 1 : Math.cos((Math.PI / 2) * progress(lane.fadeOut, frame)));

// The same fade from its progress at `frame`, but it ends `cutFrames` later
const hasten = (fade: Fade | undefined, frame: number) => {
  if (fade !== undefined && fade.from + fade.frames <= frame + cutFrames) return fade;
  const done = fade === undefined ? 0 : progress(fade, frame);
  const frames = cutFrames / (1 - done);
  return new Fade({ from: frame - done * frames, frames });
};

const release = (lane: Lane) =>
  new Lane({ ...lane, released: true, fadeOut: hasten(lane.fadeOut, lane.resampler.output) });

const trackStart = (lane: Lane, track: Track) => lane.resampler.outputAt(track.input);

// The tracks of a lane in `frames` output frames from `from`
const pieces = (lane: Lane, from: number, frames: number) =>
  lane.tracks.flatMap((track, index) => {
    const following = lane.tracks[index + 1];
    const first = Math.max(from, trackStart(lane, track));
    const last = Math.min(
      from + frames,
      following === undefined ? Number.POSITIVE_INFINITY : trackStart(lane, following),
    );
    return first < last ? [{ track, first, last }] : [];
  });

const finished = (lane: Lane) =>
  lane.resampler.done ||
  (lane.fadeOut !== undefined && lane.resampler.output >= lane.fadeOut.from + lane.fadeOut.frames);

const closeLane = (lane: Lane) =>
  Effect.forEach(lane.tracks, (track) => Scope.close(track.scope, Exit.void), { discard: true });

/** Closing the scope frees all decoders */
export const openRenderer = Effect.gen(function* () {
  const lock = yield* Semaphore.make(1);

  let queue: ReadonlyArray<Entry> = [];
  // In start order. Only the head, the last lane that is not released, takes entries from the queue.
  let lanes: Array<Lane> = [];
  let next: Start | undefined;
  let crossfade = 0;
  let timeline = 0;

  const closeAll = Effect.gen(function* () {
    const closing = lanes;
    lanes = [];
    next = undefined;
    yield* Effect.forEach(closing, closeLane, { discard: true });
  });
  yield* Effect.addFinalizer(() => closeAll);

  const head = () => lanes.findLast((lane) => !lane.released);

  // The newest lane past the middle of its fade-in, or else the oldest lane
  const currentLane = () => {
    const playing = lanes.filter((lane) => !lane.released);
    const audible = playing.findLast(
      (lane) => lane.fadeIn === undefined || lane.resampler.output >= middle(lane.fadeIn),
    );
    return audible ?? playing[0];
  };

  const replace = (lane: Lane, by: Lane) => {
    lanes = lanes.map((other) => (other === lane ? by : other));
  };

  // Entries after `lane` that play or wait already
  const laterEntries = (lane: Lane) => [
    ...lanes
      .slice(lanes.indexOf(lane) + 1)
      .filter((other) => !other.released)
      .flatMap((other) => other.tracks.map((track) => track.entry)),
    ...(next === undefined ? [] : [next.entry]),
  ];

  // Plans where `entry` starts after the head lane, which has ended. A fade-out that plays keeps on.
  const plan = (entry: Entry) => {
    const lane = head()!;
    const { resampler } = lane;
    const end = resampler.outputAt(resampler.inputEnd);
    const last = lane.tracks.at(-1)!;
    const info = readSourceInfo(entry.bytes(), entry.codec);
    const entryFrames =
      info?.frames === undefined
        ? Number.POSITIVE_INFINITY
        : (info.frames * timelineRate) / info.sampleRate;
    // Half of each entry at most, so that no entry fades out before it has faded in
    const overlap = sameAlbum(last.entry, entry)
      ? 0
      : Math.floor(Math.min(crossfade, (end - trackStart(lane, last)) / 2, entryFrames / 2));
    const at = Math.max(end - overlap, resampler.output);
    const fade = at < end ? new Fade({ from: at, frames: end - at }) : undefined;

    if (lane.fadeOut === undefined || lane.fadeOut.from >= resampler.output) {
      replace(lane, new Lane({ ...lane, fadeOut: fade }));
    }
    next = new Start({
      entry,
      position: 0,
      at,
      fadeIn: fade === undefined ? undefined : new Fade({ from: 0, frames: fade.frames }),
    });
  };

  const openLane = (start: Start) =>
    Effect.gen(function* () {
      const info = yield* readInfo(start.entry);
      if (info === undefined) return undefined;

      const resampler = new Resampler(info.sampleRate, start.position);
      const track = yield* openTrack(start.entry, info, 0);
      track.source.seek(resampler.inputEnd);
      return new Lane({
        resampler,
        tracks: [track],
        fadeIn: start.fadeIn,
        fadeOut: undefined,
        released: false,
      });
    });

  // Gives false when the lane needs bytes that did not arrive yet
  const feed = (lane: Lane) =>
    Effect.gen(function* () {
      const track = lane.tracks.at(-1)!;
      const pcm = yield* track.source
        .read(track.entry.bytes(), track.entry.complete())
        .pipe(Effect.mapError((cause) => new EntryError({ entry: track.entry.id, cause })));

      if (pcm !== undefined) {
        lane.resampler.push(pcm.channels, pcm.frames, track.gain);
        return pcm.frames > 0;
      }

      // The source ended. The next entry continues the lane if it has the same sample rate and
      // crossfade is off or it is of the same album.
      const following = queue[0];
      const joins =
        following !== undefined &&
        next === undefined &&
        lane === head() &&
        (crossfade === 0 || sameAlbum(track.entry, following));
      if (!joins) {
        lane.resampler.end();
        return true;
      }
      const info = yield* readInfo(following);
      if (info === undefined) return false;
      if (info.sampleRate !== lane.resampler.rate) {
        lane.resampler.end();
        return true;
      }

      queue = queue.slice(1);
      lane.tracks.push(yield* openTrack(following, info, lane.resampler.inputEnd));
      return true;
    });

  // Frees the decoders of tracks whose output is complete, so that the first track plays now
  const dropPlayedTracks = (lane: Lane) =>
    Effect.gen(function* () {
      while (lane.tracks.length > 1 && trackStart(lane, lane.tracks[1]!) <= lane.resampler.output) {
        yield* Scope.close(lane.tracks.shift()!.scope, Exit.void);
      }
    });

  const closeFinished = Effect.gen(function* () {
    const closing = lanes.filter(finished);
    lanes = lanes.filter((lane) => !finished(lane));
    yield* Effect.forEach(closing, closeLane, { discard: true });
  });

  // Mixes `frames` frames of all lanes into `samples` from frame `at`. In a crossfade, one gain
  // scales all lanes so that the sum of their true peaks stays at or below the ceiling.
  const mix = (samples: Float32Array, spans: Array<Span>, at: number, frames: number) => {
    const current = currentLane();
    const peaks = new Float32Array(frames);
    const gains = lanes.map((lane) => {
      const from = lane.resampler.output;
      const gain = new Float32Array(frames);
      for (const piece of pieces(lane, from, frames)) {
        for (let frame = piece.first; frame < piece.last; frame++) {
          const value = laneGain(lane, frame);
          gain[frame - from] = value;
          peaks[frame - from] = (peaks[frame - from] ?? 0) + piece.track.peak * value;
        }
        addSpan(
          spans,
          new Span({
            entry: piece.track.entry.id,
            frame: timeline + at + (piece.first - from),
            frames: piece.last - piece.first,
            position: piece.first - trackStart(lane, piece.track),
            current: lane === current,
          }),
        );
      }
      return gain;
    });

    const pcm = new Float32Array(frames * 2);
    lanes.forEach((lane, index) => {
      lane.resampler.pull(pcm, 0, frames);
      const gain = gains[index]!;
      for (let frame = 0; frame < frames; frame++) {
        const peak = peaks[frame] ?? 0;
        const value = (gain[frame] ?? 0) * (peak > peakCeiling ? peakCeiling / peak : 1);
        const out = 2 * (at + frame);
        samples[out] = (samples[out] ?? 0) + (pcm[2 * frame] ?? 0) * value;
        samples[out + 1] = (samples[out + 1] ?? 0) + (pcm[2 * frame + 1] ?? 0) * value;
      }
    });
  };

  // The current lane continues. Entries that play or wait after it must stay next.
  const follow = (lane: Lane, rest: ReadonlyArray<Entry>) =>
    Effect.gen(function* () {
      const joined = lane.tracks.slice(1).map((track) => track.entry);
      const later = laterEntries(lane);
      const matches = (entries: ReadonlyArray<Entry>, offset: number) =>
        entries.every((entry, index) => rest[offset + index]?.id === entry.id);
      if (matches(joined, 0) && matches(later, joined.length)) {
        queue = rest.slice(joined.length + later.length);
        return;
      }

      const index = lanes.indexOf(lane);
      lanes = lanes.map((other, position) =>
        position > index && !other.released ? release(other) : other,
      );
      next = undefined;

      if (matches(joined, 0)) {
        if (lane.fadeOut !== undefined && lane.fadeOut.from >= lane.resampler.output) {
          replace(lane, new Lane({ ...lane, fadeOut: undefined }));
        }
        queue = rest.slice(joined.length);
        return;
      }

      // The joined tracks must go, so the lane opens again at the same frame
      const output = lane.resampler.output;
      const fadeIn =
        lane.fadeIn !== undefined && progress(lane.fadeIn, output) < 1 ? lane.fadeIn : undefined;
      lanes = lanes.filter((other) => other !== lane);
      yield* closeLane(lane);
      next = new Start({
        entry: lane.tracks[0]!.entry,
        position: output - trackStart(lane, lane.tracks[0]!),
        at: undefined,
        fadeIn,
      });
      queue = rest;
    });

  const setQueue = (entries: ReadonlyArray<Entry>) =>
    Effect.gen(function* () {
      const [first, ...rest] = entries;
      const lane = currentLane();

      if (next !== undefined && next.at === undefined) {
        if (first?.id === next.entry.id) {
          queue = rest;
          return;
        }
      } else if (lane !== undefined && first?.id === lane.tracks[0]!.entry.id) {
        return yield* follow(lane, rest);
      } else if (lane !== undefined && first !== undefined) {
        // A skip to the entry that fades in keeps it, and the entries before it fade out
        const index = lanes.indexOf(lane);
        const incoming = lanes.slice(index + 1).find((other) => !other.released);
        if (incoming !== undefined && first.id === incoming.tracks[0]!.entry.id) {
          const output = incoming.resampler.output;
          const skipped = new Lane({
            ...incoming,
            fadeIn: incoming.fadeIn === undefined ? undefined : hasten(incoming.fadeIn, output),
          });
          lanes = lanes.map((other) => {
            if (other === incoming) return skipped;
            return other.released ? other : release(other);
          });
          return yield* follow(skipped, rest);
        }
      }

      yield* closeAll;
      next =
        first === undefined
          ? undefined
          : new Start({ entry: first, position: 0, at: undefined, fadeIn: undefined });
      queue = rest;
    }).pipe(Semaphore.withPermits(lock, 1));

  const seek = (position: number) =>
    Effect.gen(function* () {
      const target = Math.max(0, position);
      if (next !== undefined && next.at === undefined) {
        lanes = lanes.map((lane) => (lane.released ? lane : release(lane)));
        next = new Start({ ...next, position: target, fadeIn: undefined });
        return;
      }

      const lane = currentLane();
      if (lane === undefined) return;
      const following = [
        ...lane.tracks.slice(1).map((track) => track.entry),
        ...laterEntries(lane),
      ];
      lanes = lanes
        .filter((other) => other !== lane)
        .map((other) => (other.released ? other : release(other)));
      yield* closeLane(lane);
      next = new Start({
        entry: lane.tracks[0]!.entry,
        position: target,
        at: undefined,
        fadeIn: undefined,
      });
      queue = [...following, ...queue];
    }).pipe(Semaphore.withPermits(lock, 1));

  const setCrossfade = (seconds: number) =>
    Effect.sync(() => {
      crossfade = Math.max(0, Math.round(seconds * timelineRate));
      // A planned join that has not started follows the new setting
      const lane = head();
      if (lane !== undefined && next?.at !== undefined && next.at > lane.resampler.output) {
        plan(next.entry);
      }
    }).pipe(Semaphore.withPermits(lock, 1));

  const render = (frames: number) =>
    Effect.gen(function* () {
      const samples = new Float32Array(frames * 2);
      const spans: Array<Span> = [];
      let filled = 0;
      let waiting = false;

      while (filled < frames) {
        yield* closeFinished;
        if (next === undefined && head() === undefined && queue[0] !== undefined) {
          next = new Start({ entry: queue[0], position: 0, at: undefined, fadeIn: undefined });
          queue = queue.slice(1);
        }

        const playing = head();
        if (
          next !== undefined &&
          (next.at === undefined || playing === undefined || playing.resampler.output >= next.at)
        ) {
          const opened = yield* openLane(next);
          if (opened === undefined && playing === undefined) {
            waiting = true;
            break;
          }
          if (opened !== undefined) {
            lanes.push(opened);
            next = undefined;
          }
        }
        if (lanes.length === 0) break;

        const lane = head();
        if (lane !== undefined) {
          // With crossfade on, the head decodes ahead, so that its end is known before a fade starts
          const ahead = crossfade + frames - filled;
          while (crossfade > 0 && !lane.resampler.ended && lane.resampler.available < ahead) {
            if (!(yield* feed(lane))) break;
          }
          if (lane.resampler.ended && next === undefined && queue[0] !== undefined) {
            plan(queue[0]);
            queue = queue.slice(1);
            continue;
          }
        }

        // A step ends where a lane opens or passes the middle of its fade-in, so that its spans
        // keep one `current` value
        let step = frames - filled;
        const output = head()?.resampler.output;
        if (next?.at !== undefined && output !== undefined && next.at > output) {
          step = Math.min(step, next.at - output);
        }
        for (const each of lanes) {
          const left = each.fadeIn === undefined ? 0 : middle(each.fadeIn) - each.resampler.output;
          if (left > 0) step = Math.min(step, left);
        }
        for (const each of lanes) {
          while (each.resampler.available < step && !each.resampler.ended) {
            if (!(yield* feed(each))) break;
          }
        }
        if (lanes.some(finished)) continue;
        for (const each of lanes) step = Math.min(step, each.resampler.available);
        if (step === 0) {
          waiting = true;
          break;
        }

        mix(samples, spans, filled, step);
        filled += step;
        for (const each of lanes) yield* dropPlayedTracks(each);
      }

      const block = new Block({ frame: timeline, samples, spans, waiting });
      timeline += frames;
      return block;
    }).pipe(Semaphore.withPermits(lock, 1));

  return new Renderer({ setQueue, seek, setCrossfade, render });
});

// Extends a span of the same entry that ends where `span` begins
const addSpan = (spans: Array<Span>, span: Span) => {
  const index = spans.findLastIndex(
    (other) =>
      other.entry === span.entry &&
      other.current === span.current &&
      other.frame + other.frames === span.frame &&
      other.position + other.frames === span.position,
  );
  const other = spans[index];
  if (other === undefined) {
    spans.push(span);
    return;
  }
  spans[index] = new Span({ ...other, frames: other.frames + span.frames });
};
