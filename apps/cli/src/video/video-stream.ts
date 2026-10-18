import { videoUrl } from "@dyad/client-runtime";
import { clusterId, readElement, segmentId } from "@dyad/media";
import { Effect, Fiber, Match, Stream } from "effect";
import { FetchHttpClient, HttpClient } from "effect/http";

import { VideoDecoder } from "./decoder.ts";
import type { Frame } from "./messages.ts";

const timecodeId = 0xe7;
// The worker decodes this far ahead, about 160 ms at 25 fps
const queuedFrames = 4;
const chunkBytes = 256 * 1024;
// About half a 60 Hz refresh: the terminal shows a frame at its next refresh
const leadMs = 8;
// The worker skips the conversion of frames that are already late
const clockIntervalMs = 100;

/** One HTTP response of the video. A response with `start` begins at a later cluster. */
class Download {
  bytes = new Uint8Array(1024 * 1024);
  length = 0;
  done = false;
  /** The start of each cluster and its time in ms, which is the `TimecodeScale` of YouTube */
  readonly clusters: Array<{ readonly ms: number; readonly offset: number }> = [];
  private parsed = 0;
  fiber: Fiber.Fiber<void, unknown> | null = null;

  append(chunk: Uint8Array) {
    if (this.length + chunk.length > this.bytes.length) {
      const larger = new Uint8Array(Math.max(this.bytes.length * 2, this.length + chunk.length));
      larger.set(this.bytes.subarray(0, this.length));
      this.bytes = larger;
    }
    this.bytes.set(chunk, this.length);
    this.length += chunk.length;
    this.index();
  }

  // Top-level elements of the segment, as far as the bytes go
  private index() {
    const bytes = this.bytes.subarray(0, this.length);
    for (;;) {
      const element = readElement(bytes, this.parsed);
      if (element === undefined) return;
      if (element.id === segmentId) {
        this.parsed = element.start;
        continue;
      }
      if (element.id === clusterId) {
        const timecode = readElement(bytes, element.start);
        if (timecode?.end == null || timecode.end > bytes.length) return;
        if (timecode.id === timecodeId) {
          let ms = 0;
          for (let index = timecode.start; index < timecode.end; index++) {
            ms = ms * 256 + (bytes[index] ?? 0);
          }
          this.clusters.push({ ms, offset: this.parsed });
        }
      }
      // A live encoder can write clusters of unknown size, which cannot be skipped
      if (element.end === null) {
        this.parsed = Number.POSITIVE_INFINITY;
        return;
      }
      this.parsed = element.end;
    }
  }
}

class Session {
  readonly id: number;
  readonly download: Download;
  /** The head of the file before the clusters, when the session starts at a later cluster */
  prefix: Uint8Array<ArrayBuffer> | null;
  offset: number;
  waiting = false;

  constructor(
    id: number,
    download: Download,
    prefix: Uint8Array<ArrayBuffer> | null,
    offset: number,
  ) {
    this.id = id;
    this.download = download;
    this.prefix = prefix;
    this.offset = offset;
  }
}

/**
 * The frames of one source video. It keeps each response, so that a seek inside it decodes from
 * the cluster before the target; other seeks request the video from the target.
 */
export class VideoStream {
  private readonly decoder: VideoDecoder;
  private session: Session;
  private sessions = 0;
  private queue: Array<typeof Frame.Type> = [];
  private requested = 0;
  private buffers: Array<ArrayBuffer> = [];
  private clockSentAt = Number.NEGATIVE_INFINITY;
  private size: { width: number; height: number };
  private readonly serverUrl: string;
  private readonly path: string;
  private readonly onFailure: (reason: string) => void;

  /** `onSize` gets the size of the stream, `width` and `height` limit the frames */
  constructor(options: {
    readonly serverUrl: string;
    readonly path: string;
    readonly startMs: number;
    readonly width: number;
    readonly height: number;
    readonly onSize: (width: number, height: number) => void;
    readonly onFailure: (reason: string) => void;
  }) {
    this.serverUrl = options.serverUrl;
    this.path = options.path;
    this.onFailure = options.onFailure;
    this.size = { width: options.width, height: options.height };
    this.decoder = new VideoDecoder((message) =>
      Match.valueTags(message, {
        Frame: (frame) => this.receive(frame),
        Need: (need) => {
          if (need.session === this.session.id) this.feed();
        },
        Info: (info) => {
          if (info.session === this.session.id) options.onSize(info.width, info.height);
        },
        End: () => {},
        // A failure of the worker itself has no session
        Failed: (failed) => {
          if ([this.session.id, -1].includes(failed.session)) options.onFailure(failed.reason);
        },
      }),
    );
    this.session = this.start(this.request(options.startMs), null, 0);
  }

  /** Continues at `ms` */
  seek(ms: number) {
    for (const frame of this.queue.splice(0)) this.buffers.push(frame.rgba);
    const download = this.session.download;
    const cluster = download.clusters.findLast((item) => item.ms <= ms);
    const covered = download.done || download.clusters.some((item) => item.ms > ms);
    if (cluster === undefined || !covered) {
      if (download.fiber !== null) Effect.runFork(Fiber.interrupt(download.fiber));
      this.session = this.start(this.request(ms), null, 0);
    } else {
      const first = download.clusters[0];
      const prefix =
        first === undefined || first === cluster ? null : download.bytes.slice(0, first.offset);
      this.session = this.start(download, prefix, prefix === null ? 0 : cluster.offset);
    }
    this.pull(ms);
  }

  /** The frame to show at `nowMs`, if a new one is due. Pass it to `release` after use. */
  take(nowMs: number) {
    while ((this.queue[1]?.ms ?? Number.POSITIVE_INFINITY) <= nowMs + leadMs) {
      const late = this.queue.shift();
      if (late !== undefined) this.buffers.push(late.rgba);
    }
    const due = this.queue[0];
    if (due === undefined || due.ms > nowMs + leadMs) return undefined;
    this.queue.shift();
    return due;
  }

  release(frame: typeof Frame.Type) {
    this.buffers.push(frame.rgba);
  }

  /** Asks for more frames and tells the worker the clock */
  pull(nowMs: number) {
    const frames = Math.max(0, queuedFrames - this.queue.length - this.requested);
    const now = performance.now();
    if (frames === 0 && this.buffers.length === 0 && now - this.clockSentAt < clockIntervalMs) {
      return;
    }
    this.clockSentAt = now;
    this.requested += frames;
    this.decoder.pull(frames, nowMs, this.buffers.splice(0));
  }

  /** Later frames fit in `width` by `height` pixels */
  resize(width: number, height: number) {
    this.size = { width, height };
    this.decoder.resize(width, height);
  }

  close() {
    const fiber = this.session.download.fiber;
    if (fiber !== null) Effect.runFork(Fiber.interrupt(fiber));
    this.decoder.close();
  }

  private start(download: Download, prefix: Uint8Array<ArrayBuffer> | null, offset: number) {
    const session = new Session(++this.sessions, download, prefix, offset);
    this.requested = 0;
    this.decoder.open(session.id, this.size.width, this.size.height);
    return session;
  }

  private request(startMs: number) {
    const download = new Download();
    const url = videoUrl(this.serverUrl, this.path, startMs);
    const wake = () => {
      if (this.session.download === download && this.session.waiting) this.feed();
    };
    download.fiber = Effect.runFork(
      Effect.gen(function* () {
        const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
        const response = yield* client.get(url);
        yield* Stream.runForEach(response.stream, (chunk) =>
          Effect.sync(() => {
            download.append(chunk);
            wake();
          }),
        );
        download.done = true;
        wake();
      }).pipe(
        Effect.catch(() => Effect.sync(() => this.onFailure("The video does not load"))),
        Effect.provide(FetchHttpClient.layer),
      ),
    );
    return download;
  }

  private feed() {
    const session = this.session;
    const download = session.download;
    session.waiting = false;
    if (session.prefix !== null) {
      this.decoder.data(session.id, session.prefix.slice());
      session.prefix = null;
      return;
    }
    if (session.offset < download.length) {
      const end = Math.min(download.length, session.offset + chunkBytes);
      this.decoder.data(session.id, download.bytes.slice(session.offset, end));
      session.offset = end;
      return;
    }
    if (download.done) this.decoder.data(session.id, null);
    else session.waiting = true;
  }

  private receive(frame: typeof Frame.Type) {
    if (frame.session !== this.session.id) {
      this.buffers.push(frame.rgba);
      return;
    }
    this.requested = Math.max(0, this.requested - 1);
    this.queue.push(frame);
  }
}
