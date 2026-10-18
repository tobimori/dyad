// @effect-diagnostics asyncFunction:off -- OpenTUI 0.6.6 pulls PCM from an async iterable
// @effect-diagnostics newPromise:off -- the iterable waits outside the Effect runtime
// @effect-diagnostics globalTimers:off -- the iterable waits outside the Effect runtime
import type { TimedFrame } from "@dyad/domain";
import type { Audio, AudioStream } from "@opentui/core";
import { Data } from "effect";

const rate = 44100;
const chunkFrames = 441;
// OpenTUI 0.6.6 queues about 1 s without a limit. A shorter queue makes a flush and a correction
// take effect sooner; a longer one survives longer stalls of the UI thread.
const queueFrames = 0.3 * rate;
// Larger errors jump. Smaller ones move by one frame per chunk, which is not audible.
const jumpFrames = 0.005 * rate;
const slewFrames = 0.0005 * rate;
// `framesPlayed` steps by a period, so the earliest reading of the last seconds is the true start.
// A device that loses periods moves the start later, which the recent readings show sooner.
const startWindowUs = 3_000_000;
const recentUs = 1_000_000;
const startStepUs = 3000;
// The stream stops after this long without audio
const idleUs = 3_000_000;

class Block extends Data.Class<{
  /** Frame of the first sample, counted from the first block after the last flush */
  readonly frame: number;
  readonly samples: Float32Array;
}> {}

class StartReading extends Data.Class<{ readonly atUs: number; readonly startUs: number }> {}

const nowUs = () => Number(process.hrtime.bigint() / 1000n);

/**
 * Plays the blocks of a group at their server times on this device's audio output. Local time is
 * `Clock.monotonicTimeNanos` in µs, like `serverTime` takes it.
 */
export class GroupPlayer {
  private blocks: Array<Block> = [];
  // Server time of frame 0 of the blocks
  private originUs: number | undefined;
  private stream: AudioStream | undefined;
  // Tells the chunks of a stopped stream apart; `undefined` while no stream plays
  private generation: number | undefined;
  private generations = 0;
  private written = 0;
  // The block frame that the next stream frame plays
  private cursor: number | undefined;
  private readings: Array<StartReading> = [];
  private underruns = 0;
  private lastAudioUs = 0;

  private readonly audio: Audio;
  private readonly serverTime: (localUs: number) => number | undefined;

  constructor(audio: Audio, serverTime: (localUs: number) => number | undefined) {
    this.audio = audio;
    this.serverTime = serverTime;
  }

  push(frame: TimedFrame) {
    const origin = this.originUs ?? frame.playAtUs;
    this.originUs = origin;
    const first = Math.round(((frame.playAtUs - origin) * rate) / 1_000_000);
    this.blocks.push(new Block({ frame: first, samples: frame.samples }));
    this.lastAudioUs = nowUs();
    if (this.generation === undefined) this.start();
  }

  /** Drops the audio that did not play yet, at once */
  flush() {
    this.blocks = [];
    this.originUs = undefined;
    this.cursor = undefined;
    this.stop();
  }

  close() {
    this.flush();
  }

  private start() {
    this.generations += 1;
    const generation = this.generations;
    this.generation = generation;
    this.written = 0;
    this.readings = [];
    this.underruns = 0;
    this.audio.start();
    const chunks = this.chunks(generation);
    void this.audio
      .playStream(chunks, {
        format: "pcm",
        sampleFormat: "f32le",
        sampleRate: rate,
        channels: 2,
        buffer: { capacityMs: 300, startupMs: 20, resumeMs: 20 },
      })
      .then((stream) => {
        if (this.generation === generation) this.stream = stream;
        else stream.dispose();
      });
  }

  private stop() {
    this.generation = undefined;
    this.stream?.dispose();
    this.stream = undefined;
  }

  // Notes when stream frame 0 played, as `framesPlayed` shows it now. Gives the queued frames.
  private observe() {
    const stats = this.stream?.getStats();
    if (stats === undefined) return this.written;
    const played = Number(stats.framesPlayed);
    const now = nowUs();
    // An underrun moves the start later
    if (stats.underruns !== this.underruns) {
      this.underruns = stats.underruns;
      this.readings = [];
    }
    if (stats.state === "playing" && played > 0) {
      this.readings.push(new StartReading({ atUs: now, startUs: now - (played * 1e6) / rate }));
    }
    return this.written - played;
  }

  // Local time at which stream frame 0 plays
  private streamStartUs() {
    const now = nowUs();
    this.readings = this.readings.filter((reading) => reading.atUs > now - startWindowUs);
    const earliest = (readings: ReadonlyArray<StartReading>) =>
      Math.min(...readings.map((reading) => reading.startUs));
    const recent = this.readings.filter((reading) => reading.atUs > now - recentUs);
    if (recent.length === 0) return undefined;
    if (earliest(recent) - earliest(this.readings) > startStepUs) this.readings = recent;
    return earliest(this.readings);
  }

  private async *chunks(generation: number) {
    while (this.generation === generation) {
      if (this.observe() > queueFrames) {
        await new Promise((resolve) => setTimeout(resolve, 5));
        continue;
      }
      if (this.blocks.length === 0 && nowUs() - this.lastAudioUs > idleUs) {
        this.stop();
        return;
      }
      const chunk = this.fill();
      this.written += chunkFrames;
      yield new Uint8Array(chunk.buffer);
    }
  }

  private fill() {
    const out = new Float32Array(chunkFrames * 2);
    const start = this.streamStartUs();
    const origin = this.originUs;
    const server =
      start === undefined ? undefined : this.serverTime(start + (this.written * 1e6) / rate);
    if (server === undefined || origin === undefined) return out;

    const wanted = ((server - origin) * rate) / 1_000_000;
    const error = this.cursor === undefined ? Number.POSITIVE_INFINITY : wanted - this.cursor;
    if (Math.abs(error) > jumpFrames) this.cursor = Math.round(wanted);
    const cursor = this.cursor ?? Math.round(wanted);
    // Ahead of the clock repeats a frame, behind it skips one
    const slew = Math.abs(error) > slewFrames ? Math.sign(error) : 0;

    this.blocks = this.blocks.filter(
      (block) => block.frame + block.samples.length / 2 > cursor - chunkFrames,
    );
    for (let index = 0; index < chunkFrames; index++) {
      const frame = cursor + index + (slew < 0 && index > chunkFrames / 2 ? -1 : 0);
      const block = this.blocks.find(
        (each) => frame >= each.frame && frame < each.frame + each.samples.length / 2,
      );
      if (block === undefined) continue;
      const offset = (frame - block.frame) * 2;
      out[index * 2] = block.samples[offset] ?? 0;
      out[index * 2 + 1] = block.samples[offset + 1] ?? 0;
    }
    this.cursor = cursor + chunkFrames + slew;
    return out;
  }
}
