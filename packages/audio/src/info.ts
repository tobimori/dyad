import { Data } from "effect";

/** What the header of a FLAC or MP3 file says about its audio */
export class SourceInfo extends Data.Class<{
  readonly codec: "flac" | "mp3";
  readonly sampleRate: number;
  /** Byte offset of the first audio frame */
  readonly dataOffset: number;
  /** Decoded frames before the first source frame: encoder priming and decoder delay */
  readonly delay: number;
  /** Source frames without priming and padding, if the header says */
  readonly frames: number | undefined;
  /** For FLAC, the metadata, which a decoder reads before the frames */
  readonly prefix: Uint8Array;
}> {}

/** A decoder that reads `prefix`, then the received bytes from `offset`, starts at `frame` */
export class SeekPoint extends Data.Class<{
  /** For FLAC, the metadata */
  readonly prefix: Uint8Array;
  readonly offset: number;
  /** Source frame of the first decoded frame. It is negative in the priming. */
  readonly frame: number;
}> {}

// Reading past the received bytes gives 0, which no header check accepts
export const byteAt = (bytes: Uint8Array, index: number) => bytes[index] ?? 0;

export const latin1 = (bytes: Uint8Array, start: number, length: number) =>
  new TextDecoder("latin1").decode(bytes.subarray(start, start + length));
