import { openSource, readSourceInfo } from "@dyad/audio";
import type { Source, SourceInfo } from "@dyad/audio";
import { Data, Effect, Exit, Scope, Semaphore } from "effect";

import { entryLevel, peakCeiling } from "./loudness.ts";
import type { Loudness } from "./loudness.ts";
import { defaultMaxTempoChange, planTransition } from "./planner.ts";
import type { DjAnalysis, DjStyle, Transition } from "./planner.ts";
import { Resampler, timelineRate } from "./resampler.ts";
import { openStretcher } from "./stretch.ts";
import { echoPeak, TransitionEffects, transitionGain } from "./styles.ts";
import { entryAt, TempoMap, Warp } from "./warp.ts";

/** One queue entry. Its bytes can still arrive while it plays. */
export class Entry extends Data.Class<{
  /** Queue entry ID: the same source twice in a queue has two IDs */
  readonly id: string;
  readonly codec: "flac" | "mp3";
  /** Adjacent entries of one album join gapless, also with crossfade on */
  readonly album: string | undefined;
  /** The received bytes that the entry keeps, from byte `start()` of the file */
  readonly bytes: () => Uint8Array;
  readonly start?: () => number;
  readonly complete: () => boolean;
  /** The first byte that the track still needs, as `Source.needs` gives it */
  readonly needs?: (offset: number | undefined) => void;
  /** Without it, the entry plays 8 dB quieter */
  readonly loudness: Loudness | undefined;
  /** Without it, DJ mode joins the entry by crossfade */
  readonly dj?: DjAnalysis | undefined;
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
  /**
   * The entry that plays now. In a crossfade or a DJ transition, the next entry is current from
   * the middle on.
   */
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
  /**
   * Turns DJ mode on with a style, or off with `undefined`. Entries with `dj` analysis then join
   * by beat-matched transitions, other entries by crossfade. A transition that plays already
   * continues.
   */
  readonly setDj: (style: DjStyle | undefined) => Effect.Effect<void>;
  /** Renders the next `frames` timeline frames */
  readonly render: (frames: number) => Effect.Effect<Block, EntryError>;
}> {}

/** Crossfade length when the user turns crossfade on */
export const defaultCrossfadeSeconds = 6;

// Fade-out of an entry that a skip or a seek stops while another entry plays
const cutFrames = 0.1 * timelineRate;

// Room for filter overshoot in a DJ transition
const djHeadroom = 10 ** (1 / 20);

// signalsmith-stretch 1.3.2 raises the true peak of loud masters by up to 4.4 dB at ±6 %
const stretchHeadroom = 10 ** (5 / 20);
const stretchEaseFrames = 4 * timelineRate;

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

// One side of a DJ transition. The effects keep the filter and echo state.
class DjFade extends Data.Class<{
  readonly transition: Transition;
  readonly effects: TransitionEffects;
}> {}

// The gain goes along an equal-power curve, or a DJ style, over `frames` lane frames from `from`
class Fade extends Data.Class<{
  readonly from: number;
  readonly frames: number;
  readonly dj?: DjFade;
}> {}

// Entries of one sample rate play through one resampler, so that their joins stay gapless. Lane
// frames are the resampler's output frames, except while a warp stretches the lane.
class Lane extends Data.Class<{
  readonly resampler: Resampler;
  readonly warp: Warp | undefined;
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
  /** The first lane frame. Without `tempo`, it is the entry position. */
  readonly position: number;
  readonly at: number | undefined;
  readonly fadeIn: Fade | undefined;
  readonly tempo?: TempoMap;
}> {}

// An entry can drop its first bytes after the header was read
const infos = new WeakMap<Entry, SourceInfo>();

const infoOf = (entry: Entry) => {
  const known = infos.get(entry);
  if (known !== undefined || (entry.start?.() ?? 0) > 0) return known;
  const info = readSourceInfo(entry.bytes(), entry.codec);
  if (info !== undefined) infos.set(entry, info);
  return info;
};

const readInfo = (entry: Entry) => {
  const info = infoOf(entry);
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

// The track's true peak in `frames` lane frames from entry position `position`. In the bars of a
// grid with bar peaks, it is the largest bar peak, else the source's true peak.
const piecePeak = (track: Track, position: number, frames: number) => {
  const dj = track.entry.dj;
  if (dj === undefined) return track.peak;
  // Room for a warp's stretch and for decoder frames that start before a bar
  const from = position / timelineRate - 0.05;
  const to = (position + frames * (1 + defaultMaxTempoChange)) / timelineRate + 0.05;
  for (const grid of [dj.intro, dj.outro]) {
    if (grid.peaksFrom === undefined || grid.truePeaks === undefined) continue;
    const bar = 240 / grid.bpm;
    const first = Math.floor((from - grid.peaksFrom) / bar);
    const last = Math.floor((to - grid.peaksFrom) / bar);
    if (first < 0 || last >= grid.truePeaks.length) continue;
    const db = Math.max(...grid.truePeaks.slice(first, last + 1));
    return Math.min(track.peak, track.gain * 10 ** (db / 20));
  }
  return track.peak;
};

const sameAlbum = (a: Entry, b: Entry) => a.album !== undefined && a.album === b.album;

const progress = (fade: Fade, frame: number) =>
  Math.min(1, Math.max(0, (frame - fade.from) / fade.frames));

const middle = (fade: Fade) => Math.ceil(fade.from + fade.frames / 2);

const fadeGain = (fade: Fade | undefined, incoming: boolean, frame: number) => {
  if (fade === undefined) return 1;
  const done = progress(fade, frame);
  if (fade.dj !== undefined) return transitionGain(fade.dj.transition, incoming, done);
  return incoming ? Math.sin((Math.PI / 2) * done) : Math.cos((Math.PI / 2) * done);
};

const laneGain = (lane: Lane, frame: number) =>
  fadeGain(lane.fadeIn, true, frame) * fadeGain(lane.fadeOut, false, frame);

// Stretched audio keeps its headroom until the lane plays only direct audio, then it eases out
const stretchPeak = (lane: Lane, frame: number) => {
  if (lane.warp === undefined) return 1;
  const direct = (frame - lane.warp.directFrom) / stretchEaseFrames;
  return 1 + (stretchHeadroom - 1) * (1 - Math.min(1, Math.max(0, direct)));
};

// The lane's share of the true peak bound. DJ effects get headroom that eases in and out.
const lanePeak = (lane: Lane, frame: number) => {
  const { fadeIn, fadeOut } = lane;
  const gain = laneGain(lane, frame) * stretchPeak(lane, frame);
  if (fadeOut?.dj !== undefined && frame >= fadeOut.from) {
    const done = progress(fadeOut, frame);
    const ease = Math.min(1, done * 16);
    return gain * (1 + (djHeadroom - 1) * ease) + echoPeak(fadeOut.dj.transition, done);
  }
  if (fadeIn?.dj !== undefined) {
    const ease = Math.min(1, (1 - progress(fadeIn, frame)) * 16);
    return gain * (1 + (djHeadroom - 1) * ease);
  }
  return gain;
};

const warping = (lane: Lane) => lane.warp !== undefined && !lane.warp.done;

// The next lane frame
const clock = (lane: Lane) =>
  lane.warp === undefined || lane.warp.done ? lane.resampler.output : lane.warp.output;

const available = (lane: Lane) =>
  lane.warp === undefined ? lane.resampler.available : lane.warp.available(lane.resampler);

const pull = (lane: Lane, out: Float32Array, frames: number) =>
  lane.warp === undefined
    ? lane.resampler.pull(out, 0, frames)
    : lane.warp.pull(lane.resampler, out, 0, frames);

// The same fade from its progress at `frame`, but it ends `cutFrames` later
const hasten = (fade: Fade | undefined, frame: number) => {
  if (fade !== undefined && fade.from + fade.frames <= frame + cutFrames) return fade;
  const done = fade === undefined ? 0 : progress(fade, frame);
  const frames = cutFrames / (1 - done);
  return new Fade({ ...fade, from: frame - done * frames, frames });
};

const release = (lane: Lane) =>
  new Lane({ ...lane, released: true, fadeOut: hasten(lane.fadeOut, clock(lane)) });

const trackStart = (lane: Lane, track: Track) => lane.resampler.outputAt(track.input);

// The tracks of a lane in `frames` lane frames from `from`, with the entry position of each
const pieces = (lane: Lane, from: number, frames: number) => {
  if (lane.warp !== undefined && !lane.warp.done) {
    // A warp ends before the next entry joins its lane
    const track = lane.tracks[0]!;
    const position = Math.round(entryAt(lane.warp.map, from)) - trackStart(lane, track);
    return [{ track, first: from, last: from + frames, position }];
  }
  return lane.tracks.flatMap((track, index) => {
    const following = lane.tracks[index + 1];
    const first = Math.max(from, trackStart(lane, track));
    const last = Math.min(
      from + frames,
      following === undefined ? Number.POSITIVE_INFINITY : trackStart(lane, following),
    );
    return first < last ? [{ track, first, last, position: first - trackStart(lane, track) }] : [];
  });
};

const finished = (lane: Lane) =>
  (lane.warp !== undefined && !lane.warp.done
    ? lane.warp.finished(lane.resampler)
    : lane.resampler.done) ||
  (lane.fadeOut !== undefined && clock(lane) >= lane.fadeOut.from + lane.fadeOut.frames);

// Applies the gains and the DJ style of the fade that plays to `frames` frames from lane frame `from`
const applyFades = (
  lane: Lane,
  pcm: Float32Array,
  gains: Float32Array,
  from: number,
  frames: number,
) => {
  const { fadeIn, fadeOut } = lane;
  const outgoing = fadeOut?.dj !== undefined && from + frames > fadeOut.from;
  const fade = outgoing ? fadeOut : fadeIn;
  if (fade?.dj === undefined || (!outgoing && progress(fade, from) >= 1)) {
    for (let frame = 0; frame < frames; frame++) {
      pcm[2 * frame] = (pcm[2 * frame] ?? 0) * (gains[frame] ?? 0);
      pcm[2 * frame + 1] = (pcm[2 * frame + 1] ?? 0) * (gains[frame] ?? 0);
    }
    return;
  }
  fade.dj.effects.process(
    fade.dj.transition,
    !outgoing,
    pcm,
    gains,
    frames,
    (from - fade.from) / fade.frames,
    1 / fade.frames,
  );
};

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
  let dj: DjStyle | undefined;
  let timeline = 0;

  // DJ mode falls back to a crossfade also when crossfade is off
  const fadeFrames = () =>
    crossfade === 0 && dj !== undefined ? defaultCrossfadeSeconds * timelineRate : crossfade;

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
      (lane) => lane.fadeIn === undefined || clock(lane) >= middle(lane.fadeIn),
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
    const info = infoOf(entry);
    const entryFrames =
      info?.frames === undefined
        ? Number.POSITIVE_INFINITY
        : (info.frames * timelineRate) / info.sampleRate;
    // Half of each entry at most, so that no entry fades out before it has faded in
    const overlap = sameAlbum(last.entry, entry)
      ? 0
      : Math.floor(Math.min(fadeFrames(), (end - trackStart(lane, last)) / 2, entryFrames / 2));
    const at = Math.max(end - overlap, clock(lane));
    const fade = at < end ? new Fade({ from: at, frames: end - at }) : undefined;

    if (lane.fadeOut === undefined || lane.fadeOut.from >= clock(lane)) {
      replace(lane, new Lane({ ...lane, fadeOut: fade }));
    }
    next = new Start({
      entry,
      position: 0,
      at,
      fadeIn: fade === undefined ? undefined : new Fade({ from: 0, frames: fade.frames }),
    });
  };

  // Plans a beat-matched transition from the head lane into `entry`. Gives false for a crossfade.
  const planDj = (entry: Entry) => {
    const lane = head()!;
    const last = lane.tracks.at(-1)!;
    if (dj === undefined || warping(lane) || lane.fadeOut !== undefined) return false;
    if (last.entry.dj === undefined || entry.dj === undefined || sameAlbum(last.entry, entry)) {
      return false;
    }
    const transition = planTransition(last.entry.dj, entry.dj, dj);
    if (transition === undefined) return false;
    const at = trackStart(lane, last) + Math.round(transition.out * timelineRate);
    if (at <= clock(lane)) return false;

    const frames = Math.round(transition.beats * transition.beat * timelineRate);
    const rampFrames = Math.round(
      ((transition.rampBeats * transition.beat * (1 + transition.rate)) / 2) * timelineRate,
    );
    const entryIn = transition.in * timelineRate;
    // B's lane frames are its entry frames after the ramp, within half a frame
    const frame = Math.round(entryIn + (transition.rate - 1) * (frames + rampFrames / 2));
    const side = () => new DjFade({ transition, effects: new TransitionEffects() });
    replace(lane, new Lane({ ...lane, fadeOut: new Fade({ from: at, frames, dj: side() }) }));
    next = new Start({
      entry,
      position: frame,
      at,
      fadeIn: new Fade({ from: frame, frames, dj: side() }),
      tempo: new TempoMap({ frame, entry: entryIn, rate: transition.rate, frames, rampFrames }),
    });
    return true;
  };

  // A lane that opens `late` frames after its start keeps the timing of its fade and tempo
  const openLane = (start: Start, late: number) =>
    Effect.gen(function* () {
      const info = yield* readInfo(start.entry);
      if (info === undefined) return undefined;

      const warp =
        start.tempo === undefined
          ? undefined
          : new Warp(yield* openStretcher(), start.tempo, start.position + late);
      const resampler = new Resampler(info.sampleRate, warp?.inputStart ?? start.position);
      const track = yield* openTrack(start.entry, info, 0);
      track.source.seek(resampler.inputEnd);
      return new Lane({
        resampler,
        warp,
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
        .read(track.entry.bytes(), track.entry.complete(), track.entry.start?.() ?? 0)
        .pipe(Effect.mapError((cause) => new EntryError({ entry: track.entry.id, cause })));
      track.entry.needs?.(track.source.needs());

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
        !warping(lane) &&
        (fadeFrames() === 0 || sameAlbum(track.entry, following));
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
    const froms = lanes.map(clock);
    const gains = lanes.map((lane, index) => {
      const from = froms[index]!;
      const gain = new Float32Array(frames);
      for (const piece of pieces(lane, from, frames)) {
        const peak = piecePeak(piece.track, piece.position, piece.last - piece.first);
        for (let frame = piece.first; frame < piece.last; frame++) {
          gain[frame - from] = laneGain(lane, frame);
          peaks[frame - from] = (peaks[frame - from] ?? 0) + peak * lanePeak(lane, frame);
        }
        addSpan(
          spans,
          new Span({
            entry: piece.track.entry.id,
            frame: timeline + at + (piece.first - from),
            frames: piece.last - piece.first,
            position: piece.position,
            current: lane === current,
          }),
        );
      }
      return gain;
    });

    const pcm = new Float32Array(frames * 2);
    lanes.forEach((lane, index) => {
      pull(lane, pcm, frames);
      applyFades(lane, pcm, gains[index]!, froms[index]!, frames);
      for (let frame = 0; frame < frames; frame++) {
        const peak = peaks[frame] ?? 0;
        const value = peak > peakCeiling ? peakCeiling / peak : 1;
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
        if (lane.fadeOut !== undefined && lane.fadeOut.from >= clock(lane)) {
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
          const output = clock(incoming);
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
      if (
        lane !== undefined &&
        next?.at !== undefined &&
        next.tempo === undefined &&
        next.at > clock(lane)
      ) {
        plan(next.entry);
      }
    }).pipe(Semaphore.withPermits(lock, 1));

  const setDj = (style: DjStyle | undefined) =>
    Effect.sync(() => {
      dj = style;
      // A planned join that has not started is planned again
      const lane = head();
      if (lane === undefined || next?.at === undefined || next.at <= clock(lane)) return;
      queue = [next.entry, ...queue];
      next = undefined;
      if (lane.fadeOut !== undefined && lane.fadeOut.from >= clock(lane)) {
        replace(lane, new Lane({ ...lane, fadeOut: undefined }));
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
          (next.at === undefined || playing === undefined || clock(playing) >= next.at)
        ) {
          const late =
            next.at === undefined || playing === undefined ? 0 : clock(playing) - next.at;
          const opened = yield* openLane(next, late);
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
          if (next === undefined && queue[0] !== undefined && planDj(queue[0])) {
            queue = queue.slice(1);
            continue;
          }
          // With crossfade on, the head decodes ahead, so that its end is known before a fade starts
          const ahead = fadeFrames() + frames - filled;
          while (fadeFrames() > 0 && !lane.resampler.ended && lane.resampler.available < ahead) {
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
        const output = lane === undefined ? undefined : clock(lane);
        if (next?.at !== undefined && output !== undefined && next.at > output) {
          step = Math.min(step, next.at - output);
        }
        for (const each of lanes) {
          const left = each.fadeIn === undefined ? 0 : middle(each.fadeIn) - clock(each);
          if (left > 0) step = Math.min(step, left);
        }
        for (const each of lanes) {
          while (available(each) < step && !each.resampler.ended) {
            if (!(yield* feed(each))) break;
          }
        }
        if (lanes.some(finished)) continue;
        for (const each of lanes) step = Math.min(step, available(each));
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

  return new Renderer({ setQueue, seek, setCrossfade, setDj, render });
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
