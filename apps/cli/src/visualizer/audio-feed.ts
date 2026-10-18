import { openSource, readSourceInfo } from "@dyad/audio";
import type { DecodeError, Source, SourceInfo } from "@dyad/audio";
import { SampleRing } from "@dyad/visualizer";
import { Data, Effect, Exit, Scope } from "effect";

/**
 * One response of the audio output, for the visualizer. It decodes the bytes a second time, until
 * the PCM engine can give its samples.
 */
export class AudioTap extends Data.Class<{
  readonly codec: "flac" | "mp3";
  /** Source time of the first frame of the response */
  readonly startMs: number;
  /** All bytes received so far */
  readonly bytes: () => Uint8Array;
  readonly complete: () => boolean;
}> {}

// The analyzer reads 2048 samples before the position, so a jump starts the decoder a bit earlier
const leadSeconds = 0.25;
const aheadSeconds = 1;

class Opened extends Data.Class<{
  readonly tap: AudioTap;
  readonly info: SourceInfo;
  readonly source: Source;
  readonly scope: Scope.Closeable;
}> {}

/** Decodes the tapped response into `ring`, only near the play position */
export class AudioFeed {
  // One decode step can give 8 s of low bit rate MP3, so the ring must hold more than that
  readonly ring = new SampleRing(1 << 20);
  private tap: AudioTap | null = null;
  private opened: Opened | null = null;
  private busy = false;
  private seekNeeded = true;

  /** Starts the next decode step and gives the ring frame of `positionMs` */
  update(tap: AudioTap, positionMs: number) {
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

  private open(tap: AudioTap) {
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
