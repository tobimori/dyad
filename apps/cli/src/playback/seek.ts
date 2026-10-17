import { Data } from "effect";

/** A new decoder reads `prefix`, for FLAC its metadata, then the received bytes from `offset` */
export class SeekPoint extends Data.Class<{
  readonly prefix: Uint8Array;
  readonly offset: number;
  /** Source time of the first frame */
  readonly ms: number;
}> {}

// Reading past the received bytes gives 0, which no header check accepts
const byteAt = (bytes: Uint8Array, index: number) => bytes[index] ?? 0;

export const startPoint = new SeekPoint({ prefix: new Uint8Array(0), offset: 0, ms: 0 });

/**
 * The last received frame that starts at or before `ms`. OpenTUI 0.6.6 cannot seek in a stream,
 * so a seek starts a new decoder there.
 */
export const findSeekPoint = (bytes: Uint8Array, format: "flac" | "mp3", ms: number) =>
  format === "flac" ? flacSeekPoint(bytes, ms) : mp3SeekPoint(bytes, ms);

const flacSeekPoint = (bytes: Uint8Array, ms: number) => {
  const info = flacStreamInfo(bytes);
  if (info === undefined) return undefined;

  const target = (ms / 1000) * info.sampleRate;
  const frameAt = (position: number) => nextFlacFrame(bytes, position, info.blockSize);

  // `low` is always a frame that starts at or before the target
  let low = info.headerLength;
  let high = bytes.length;
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    const frame = frameAt(middle);
    if (frame === undefined || frame.sample > target) {
      high = middle;
    } else {
      low = frame.offset;
    }
  }

  const frame = frameAt(low);
  if (frame === undefined) return undefined;

  return new SeekPoint({
    prefix: bytes.subarray(0, info.headerLength),
    offset: frame.offset,
    ms: (frame.sample / info.sampleRate) * 1000,
  });
};

// "fLaC", then metadata blocks. STREAMINFO is always the first block.
const flacStreamInfo = (bytes: Uint8Array) => {
  const marker = new TextDecoder().decode(bytes.subarray(0, 4));
  if (marker !== "fLaC" || bytes.length < 42) return undefined;

  let headerLength = 4;
  let last = false;
  while (!last) {
    if (headerLength + 4 > bytes.length) return undefined;
    last = (byteAt(bytes, headerLength) & 0x80) !== 0;
    const blockLength =
      (byteAt(bytes, headerLength + 1) << 16) |
      (byteAt(bytes, headerLength + 2) << 8) |
      byteAt(bytes, headerLength + 3);
    headerLength += 4 + blockLength;
  }

  return {
    headerLength,
    blockSize: (byteAt(bytes, 8) << 8) | byteAt(bytes, 9),
    sampleRate: (byteAt(bytes, 18) << 12) | (byteAt(bytes, 19) << 4) | (byteAt(bytes, 20) >> 4),
  };
};

class FlacFrame extends Data.Class<{ readonly offset: number; readonly sample: number }> {}

const nextFlacFrame = (bytes: Uint8Array, from: number, blockSize: number) => {
  for (let offset = from; offset + 16 < bytes.length; offset++) {
    const sample = flacFrameSample(bytes, offset, blockSize);
    if (sample !== undefined) return new FlacFrame({ offset, sample });
  }
  return undefined;
};

// The first sample of the frame at `offset`, or `undefined` if no valid frame header starts there.
// Audio data can contain the sync code, so the header CRC must match too.
const flacFrameSample = (bytes: Uint8Array, offset: number, blockSize: number) => {
  if (bytes[offset] !== 0xff || (byteAt(bytes, offset + 1) & 0xfe) !== 0xf8) return undefined;

  const blockSizeCode = byteAt(bytes, offset + 2) >> 4;
  const sampleRateCode = byteAt(bytes, offset + 2) & 0x0f;
  const channels = byteAt(bytes, offset + 3) >> 4;
  const reserved = byteAt(bytes, offset + 3) & 0x01;
  if (blockSizeCode === 0 || sampleRateCode === 15 || channels > 10 || reserved !== 0) {
    return undefined;
  }

  // The frame or sample number uses the UTF-8 byte pattern
  const first = byteAt(bytes, offset + 4);
  const leadingOnes = Math.clz32(~(first << 24));
  if (leadingOnes === 1 || leadingOnes > 7) return undefined;
  const extraBytes = leadingOnes === 0 ? 0 : leadingOnes - 1;

  let number = first & (0xff >> (leadingOnes + 1));
  for (let index = 1; index <= extraBytes; index++) {
    const byte = byteAt(bytes, offset + 4 + index);
    if ((byte & 0xc0) !== 0x80) return undefined;
    number = number * 64 + (byte & 0x3f);
  }

  let end = offset + 5 + extraBytes;
  if (blockSizeCode === 6) end += 1;
  if (blockSizeCode === 7) end += 2;
  if (sampleRateCode === 12) end += 1;
  if (sampleRateCode === 13 || sampleRateCode === 14) end += 2;
  if (end >= bytes.length || crc8(bytes, offset, end) !== bytes[end]) return undefined;

  const variableBlockSize = (byteAt(bytes, offset + 1) & 0x01) === 1;
  return variableBlockSize ? number : number * blockSize;
};

const crc8 = (bytes: Uint8Array, start: number, end: number) => {
  let crc = 0;
  for (let index = start; index < end; index++) {
    crc ^= byteAt(bytes, index);
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x80 ? ((crc << 1) ^ 0x07) & 0xff : (crc << 1) & 0xff;
    }
  }
  return crc;
};

// Layer III bit rates in kbit/s by index
const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

// Version bits 0, 2 and 3 are MPEG 2.5, 2 and 1. They divide the MPEG 1 sample rates.
const sampleRateDivisors = [4, 0, 2, 1];

class Mp3Frame extends Data.Class<{
  readonly length: number;
  readonly samples: number;
  readonly sampleRate: number;
}> {}

const mp3Frame = (bytes: Uint8Array, offset: number) => {
  if (bytes[offset] !== 0xff || (byteAt(bytes, offset + 1) & 0xe0) !== 0xe0) return undefined;

  const version = (byteAt(bytes, offset + 1) >> 3) & 0x03;
  const layer = (byteAt(bytes, offset + 1) >> 1) & 0x03;
  const bitrateIndex = byteAt(bytes, offset + 2) >> 4;
  const sampleRateIndex = (byteAt(bytes, offset + 2) >> 2) & 0x03;
  const padding = (byteAt(bytes, offset + 2) >> 1) & 0x01;
  if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15) return undefined;
  if (sampleRateIndex === 3) return undefined;

  const mpeg1 = version === 3;
  const bitrate = (mpeg1 ? mpeg1Bitrates : mpeg2Bitrates)[bitrateIndex]! * 1000;
  const sampleRate = [44100, 48000, 32000][sampleRateIndex]! / sampleRateDivisors[version]!;
  const samples = mpeg1 ? 1152 : 576;

  return new Mp3Frame({
    length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding,
    samples,
    sampleRate,
  });
};

// An ID3v2 tag has a 10-byte header with a "syncsafe" size of 7 bits per byte
const id3Length = (bytes: Uint8Array) => {
  if (new TextDecoder().decode(bytes.subarray(0, 3)) !== "ID3" || bytes.length < 10) return 0;
  const size =
    (byteAt(bytes, 6) << 21) |
    (byteAt(bytes, 7) << 14) |
    (byteAt(bytes, 8) << 7) |
    byteAt(bytes, 9);
  const footer = (byteAt(bytes, 5) & 0x10) === 0 ? 0 : 10;
  return 10 + size + footer;
};

// MP3 frames have no time stamp, so the walk counts the samples of all frames before the target
const mp3SeekPoint = (bytes: Uint8Array, ms: number) => {
  let offset = id3Length(bytes);
  let samples = 0;
  let found: SeekPoint | undefined;

  while (offset + 4 <= bytes.length) {
    const frame = mp3Frame(bytes, offset);
    if (frame === undefined) {
      offset += 1;
      continue;
    }
    if (offset + frame.length > bytes.length) break;

    const frameMs = (samples / frame.sampleRate) * 1000;
    if (frameMs > ms) break;

    found = new SeekPoint({ prefix: new Uint8Array(0), offset, ms: frameMs });
    samples += frame.samples;
    offset += frame.length;
  }

  return found;
};
