import { openSource, readSourceInfo } from "@dyad/audio";
import type { DecodeError, Source, SourceInfo } from "@dyad/audio";
import { ListenFeed } from "@dyad/client-runtime";
import { SampleRing } from "@dyad/visualizer";
import { Clock, Data, Effect, Exit, Scope } from "effect";

/**
 * One response of the audio output, for the visualizer. It decodes the bytes a second time, until
 * the PCM engine can give its samples.
 */
export class ResponseTap extends Data.Class<{
  readonly codec: "flac" | "mp3";
  /** Source time of the first frame of the response */
  readonly startMs: number;
  /** All bytes received so far */
  readonly bytes: () => Uint8Array;
  readonly complete: () => boolean;
}> {}

/** What the visualizer shows: a response that this device plays, or the audio of a timed output */
export type AudioTap = ResponseTap | ListenFeed;

const listenRate = 44100;

// The analyzer reads 2048 samples before the position, so a jump starts the decoder a bit earlier
const leadSeconds = 0.25;
const aheadSeconds = 1;

class Opened extends Data.Class<{
  readonly tap: ResponseTap;
  readonly info: SourceInfo;
  readonly source: Source;
  readonly scope: Scope.Closeable;
}> {}

/** Decodes the tapped response into `ring`, only near the play position */
export class AudioFeed {
  // One decode step can give 8 s of low bit rate MP3, so the ring must hold more than that
  readonly ring = new SampleRing(1 << 20);
  private tap: ResponseTap | null = null;
  private opened: Opened | null = null;
  private busy = false;
  private seekNeeded = true;
  // The ring frame of a listen block is its local play time in frames
  private listenEpoch = -1;

  /** Starts the next decode step and gives the ring frame of `positionMs` */
  update(tap: AudioTap, positionMs: number) {
    if (tap instanceof ListenFeed) return this.listen(tap);
    if (tap !== this.tap) {
      this.close();
      this.tap = tap;
      this.seekNeeded = true;
    }
    const opened = this.opened;
    const rate = opened?.info.sampleRate ?? this.ring.sampleRate;
    const frame = (positionMs / 1000) * rate;
    if (this.busy) return frame;
    if (opened === null) {
      this.open(tap);
      return frame;
    }

    const ring = this.ring;
    const startFrame = (tap.startMs / 1000) * rate;
    if (this.seekNeeded || frame < ring.start || frame > ring.end + rate * leadSeconds * 2) {
      const target = Math.max(0, Math.floor(frame - startFrame - rate * leadSeconds));
      opened.source.seek(target);
      ring.reset(startFrame + target, rate);
      this.seekNeeded = false;
    }
    if (ring.end < frame + rate * aheadSeconds) this.read(opened);
    return frame;
  }

  // Writes the blocks that arrived and gives the ring frame of now
  private listen(feed: ListenFeed) {
    this.close();
    const nowUs = Number(Effect.runSync(Clock.monotonicTimeNanos) / 1000n);
    const ring = this.ring;
    if (feed.epoch !== this.listenEpoch) {
      this.listenEpoch = feed.epoch;
      ring.reset(0, listenRate);
    }
    for (const block of feed.take(nowUs)) {
      // Clock corrections move a block by a few frames, which is no gap
      const frame = Math.round((block.atUs * listenRate) / 1_000_000);
      if (Math.abs(frame - ring.end) > 8) ring.reset(frame, listenRate);
      ring.write([block.samples], block.samples.length);
    }
    return (nowUs * listenRate) / 1_000_000;
  }

  close() {
    const opened = this.opened;
    this.opened = null;
    this.tap = null;
    if (opened !== null) Effect.runFork(Scope.close(opened.scope, Exit.void));
  }

  private run(effect: Effect.Effect<void, DecodeError>) {
    this.busy = true;
    Effect.runFork(
      effect.pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            this.busy = false;
          }),
        ),
      ),
    );
  }

  private open(tap: ResponseTap) {
    const info = readSourceInfo(tap.bytes(), tap.codec);
    if (info === undefined) return;
    this.run(
      Effect.gen({ self: this }, function* () {
        const scope = yield* Scope.make();
        const source = yield* openSource(info).pipe(Scope.provide(scope));
        if (this.tap !== tap) return yield* Scope.close(scope, Exit.void);
        this.opened = new Opened({ tap, info, source, scope });
      }),
    );
  }

  private read(opened: Opened) {
    this.run(
      Effect.gen({ self: this }, function* () {
        const pcm = yield* opened.source.read(opened.tap.bytes(), opened.tap.complete());
        // A new response during the decode makes the samples stale
        if (pcm === undefined || this.opened !== opened) return;
        this.ring.write(pcm.channels, pcm.frames);
      }),
    );
  }
}
