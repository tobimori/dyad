import { Data } from "effect";

import { byteAt, latin1, SeekPoint, SourceInfo } from "./info.ts";

// "fLaC", then metadata blocks. STREAMINFO is always the first block.
const streamInfo = (bytes: Uint8Array) => {
  if (latin1(bytes, 0, 4) !== "fLaC" || bytes.length < 42) return undefined;

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
  if (headerLength > bytes.length) return undefined;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    headerLength,
    blockSize: view.getUint16(8),
    sampleRate: (byteAt(bytes, 18) << 12) | (byteAt(bytes, 19) << 4) | (byteAt(bytes, 20) >> 4),
    // 36 bits; 0 if the encoder did not know the length
    totalFrames: (byteAt(bytes, 21) & 0x0f) * 2 ** 32 + view.getUint32(22),
  };
};

export const readFlacInfo = (bytes: Uint8Array) => {
  const info = streamInfo(bytes);
  if (info === undefined) return undefined;

  return new SourceInfo({
    codec: "flac",
    sampleRate: info.sampleRate,
    dataOffset: info.headerLength,
    delay: 0,
    frames: info.totalFrames === 0 ? undefined : info.totalFrames,
  });
};

// FLAC frames decode independently, so a seek point is the last received frame at or before `target`
export const flacSeekPoint = (bytes: Uint8Array, target: number) => {
  const info = streamInfo(bytes);
  if (info === undefined) return undefined;

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
    frame: frame.sample,
  });
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
