import { Data, Effect } from "effect";

import { DecodeError, openDecoder, Pcm } from "./decoder.ts";
import { flacSeekPoint, readFlacInfo } from "./flac.ts";
import type { SourceInfo } from "./info.ts";
import { mp3SeekPoint, readMp3Info } from "./mp3.ts";

/** Reads the header, or gives `undefined` until the received bytes hold all of it */
export const readSourceInfo = (bytes: Uint8Array, codec: "flac" | "mp3") =>
  codec === "flac" ? readFlacInfo(bytes) : readMp3Info(bytes);

/**
 * The last received seek point from which a decoder reaches source frame `frame`. Past the
 * received bytes, it is the last point that they hold. `bytes` starts at byte `start` of the file;
 * an MP3 seek needs all bytes from the first frame.
 */
export const findSeekPoint = (bytes: Uint8Array, info: SourceInfo, frame: number, start = 0) => {
  if (info.codec === "flac") return flacSeekPoint(bytes, info, frame, start);
  return start > info.dataOffset ? undefined : mp3SeekPoint(bytes, info, frame);
};

/** Source frames of one file, without encoder priming and padding */
export class Source extends Data.Class<{
  /** The next `read` continues at source frame `frame` */
  readonly seek: (frame: number) => void;
  /**
   * Decodes the next part of `bytes`, the received bytes from byte `start` of the file. The result
   * is empty when the source needs more bytes, and `undefined` after its last frame.
   */
  readonly read: (
    bytes: Uint8Array,
    complete: boolean,
    start?: number,
  ) => Effect.Effect<Pcm | undefined, DecodeError>;
  /**
   * The first byte that the source still needs. 0 when the bytes before the window hold the seek
   * target, `undefined` while it needs all bytes of the window to find the seek point.
   */
  readonly needs: () => number | undefined;
}> {}

const chunkBytes = 16 * 1024;
// A seek waits until the bytes reach this far past its point, so that it does not start early
const seekMarginBytes = 4 * chunkBytes;

/** The decoder lives until the scope closes */
export const openSource = Effect.fn("Audio.openSource")(function* (info: SourceInfo) {
  const decoder = yield* openDecoder(info.codec);
  const end = info.frames ?? Number.POSITIVE_INFINITY;
  const empty = new Pcm({ channels: [], frames: 0, sampleRate: info.sampleRate });

  let target = 0;
  // False until the decoder starts at the seek point for `target`
  let started = false;
  let offset = 0;
  // Source frame of the next decoded frame
  let decoded = 0;
  let flushed = false;
  let rewind = false;
  // While it waits for bytes past a FLAC seek point, the bytes before the point can go
  let searchFrom: number | undefined;

  // Drops the frames before the target and after the end of the source
  const keep = (pcm: Pcm) => {
    const first = decoded;
    decoded += pcm.frames;
    const from = Math.min(pcm.frames, Math.max(0, target - first));
    const to = Math.max(from, Math.min(pcm.frames, end - first));
    if (from === 0 && to === pcm.frames) return pcm;
    return new Pcm({
      channels: pcm.channels.map((channel) => channel.subarray(from, to)),
      frames: to - from,
      sampleRate: pcm.sampleRate,
    });
  };

  const start = (bytes: Uint8Array, complete: boolean, first: number) =>
    Effect.gen(function* () {
      const next = findSeekPoint(bytes, info, target, first);
      rewind = first > info.dataOffset && (next === undefined || next.frame > target);
      if (rewind) return false;
      // An MP3 seek counts frames from the first one, so it keeps all bytes
      searchFrom = info.codec === "flac" && next !== undefined ? next.offset : undefined;
      if (next === undefined) {
        if (complete) return yield* new DecodeError({ cause: "The file has no audio frame" });
        return false;
      }
      if (!complete && first + bytes.length - next.offset < seekMarginBytes) return false;

      yield* decoder.reset;
      yield* decoder.decode(next.prefix);
      started = true;
      offset = next.offset;
      decoded = next.frame;
      flushed = false;
      return true;
    });

  const read = (bytes: Uint8Array, complete: boolean, first = 0) =>
    Effect.gen(function* () {
      if (!started && !(yield* start(bytes, complete, first))) return empty;

      while (decoded < end) {
        if (offset < first + bytes.length) {
          const chunk = bytes.subarray(offset - first, offset - first + chunkBytes);
          offset += chunk.length;
          const pcm = keep(yield* decoder.decode(chunk));
          if (pcm.frames > 0) return pcm;
          continue;
        }

        if (!complete) return empty;
        if (flushed) return undefined;
        flushed = true;
        const pcm = keep(yield* decoder.flush);
        if (pcm.frames > 0) return pcm;
      }
      return undefined;
    });

  return new Source({
    seek: (frame) => {
      target = Math.max(0, frame);
      started = false;
      searchFrom = undefined;
    },
    read,
    needs: () => {
      if (started) return offset;
      return rewind ? 0 : searchFrom;
    },
  });
});
