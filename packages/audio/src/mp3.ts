import { Data } from "effect";

import { byteAt, latin1, SeekPoint, SourceInfo } from "./info.ts";

// Layer III bit rates in kbit/s by index
const mpeg1Bitrates = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const mpeg2Bitrates = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];

// Version bits 0, 2 and 3 are MPEG 2.5, 2 and 1. They divide the MPEG 1 sample rates.
const sampleRateDivisors = [4, 0, 2, 1];

class Mp3Frame extends Data.Class<{
  readonly length: number;
  readonly samples: number;
  readonly sampleRate: number;
  /** Byte offset of a Xing or Info tag in this frame */
  readonly tagOffset: number;
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

  // The tag follows the side information, which is shorter for mono and for MPEG 2
  const mono = byteAt(bytes, offset + 3) >> 6 === 3;
  const sideInfoLength = [
    [17, 9],
    [32, 17],
  ][mono ? 0 : 1]![mpeg1 ? 0 : 1]!;

  return new Mp3Frame({
    length: Math.floor(((samples / 8) * bitrate) / sampleRate) + padding,
    samples,
    sampleRate,
    tagOffset: offset + 4 + sideInfoLength,
  });
};

const uint32 = (bytes: Uint8Array, offset: number) =>
  ((byteAt(bytes, offset) << 24) |
    (byteAt(bytes, offset + 1) << 16) |
    (byteAt(bytes, offset + 2) << 8) |
    byteAt(bytes, offset + 3)) >>>
  0;

// An ID3v2 tag has a 10-byte header with a "syncsafe" size of 7 bits per byte
const syncsafe = (bytes: Uint8Array, offset: number) =>
  (byteAt(bytes, offset) << 21) |
  (byteAt(bytes, offset + 1) << 14) |
  (byteAt(bytes, offset + 2) << 7) |
  byteAt(bytes, offset + 3);

const id3Length = (bytes: Uint8Array) => {
  if (latin1(bytes, 0, 3) !== "ID3" || bytes.length < 10) return 0;
  const footer = (byteAt(bytes, 5) & 0x10) === 0 ? 0 : 10;
  return 10 + syncsafe(bytes, 6) + footer;
};

class Gapless extends Data.Class<{
  readonly delay: number;
  readonly frames: number | undefined;
}> {}

// mpg123 and FFmpeg add this delay of the synthesis filter bank to the encoder delay of a LAME tag
const decoderDelay = 529;

// LAME writes a first frame without audio: a Xing (VBR) or Info (CBR) tag, then the LAME tag
const lameGapless = (bytes: Uint8Array, frame: Mp3Frame) => {
  const flags = uint32(bytes, frame.tagOffset + 4);

  let position = frame.tagOffset + 8;
  const tagFrames = (flags & 0x01) === 0 ? undefined : uint32(bytes, position);
  if ((flags & 0x01) !== 0) position += 4;
  if ((flags & 0x02) !== 0) position += 4;
  if ((flags & 0x04) !== 0) position += 100;
  if ((flags & 0x08) !== 0) position += 4;

  if (!["LAME", "Lavf", "Lavc"].includes(latin1(bytes, position, 4))) return undefined;

  const delays =
    (byteAt(bytes, position + 21) << 16) |
    (byteAt(bytes, position + 22) << 8) |
    byteAt(bytes, position + 23);
  const encoderDelay = delays >> 12;
  const encoderPadding = delays & 0xfff;

  return new Gapless({
    delay: encoderDelay + decoderDelay,
    frames:
      tagFrames === undefined
        ? undefined
        : tagFrames * frame.samples - encoderDelay - encoderPadding,
  });
};

// Encodings 0 to 3 of ID3v2 text. Encoding 1 starts with a byte order mark.
const textEncodings = ["latin1", "utf-16le", "utf-16be", "utf-8"];

const id3Text = (bytes: Uint8Array, encoding: number) => {
  const bigEndian = encoding === 1 && bytes[0] === 0xfe && bytes[1] === 0xff;
  return new TextDecoder(bigEndian ? "utf-16be" : (textEncodings[encoding] ?? "latin1")).decode(
    bytes,
  );
};

/**
 * iTunes writes no LAME tag, but an ID3v2 comment "iTunSMPB" with hexadecimal fields. In iTunes
 * files the delay, the padding and the frame count add up to all decoded frames.
 */
const itunesGapless = (bytes: Uint8Array) => {
  const version = byteAt(bytes, 3);
  const flags = byteAt(bytes, 5);
  const end = id3Length(bytes);
  if (end === 0 || end > bytes.length || (version === 2 && (flags & 0x40) !== 0)) return undefined;

  // ID3v2.2 has 3-byte frame IDs and sizes; ID3v2.4 has syncsafe sizes
  const idLength = version === 2 ? 3 : 4;
  const headerLength = version === 2 ? 6 : 10;
  const frameSize = (offset: number) => {
    if (version === 2) return uint32(bytes, offset + 2) & 0xffffff;
    return version === 4 ? syncsafe(bytes, offset + 4) : uint32(bytes, offset + 4);
  };

  let offset = 10;
  if ((flags & 0x40) !== 0) offset += version === 3 ? uint32(bytes, 10) + 4 : syncsafe(bytes, 10);
  while (offset + headerLength <= end && bytes[offset] !== 0) {
    const id = latin1(bytes, offset, idLength);
    const size = frameSize(offset);
    const body = bytes.subarray(offset + headerLength, offset + headerLength + size);
    offset += headerLength + size;
    if (id !== "COMM" && id !== "COM") continue;

    // Encoding, language, description, text. UTF-16 strings end with two zero bytes.
    const encoding = byteAt(body, 0);
    const step = encoding === 1 || encoding === 2 ? 2 : 1;
    let separator = 4;
    while (separator < body.length && (body[separator] !== 0 || body[separator + step - 1] !== 0)) {
      separator += step;
    }
    if (id3Text(body.subarray(4, separator), encoding) !== "iTunSMPB") continue;

    const fields = /^\s*[0-9a-f]{8} ([0-9a-f]{8}) [0-9a-f]{8} ([0-9a-f]{16})/i.exec(
      id3Text(body.subarray(separator + step), encoding),
    );
    if (fields === null) return undefined;
    const frames = Number.parseInt(fields[2]!, 16);
    return new Gapless({
      delay: Number.parseInt(fields[1]!, 16),
      frames: frames === 0 ? undefined : frames,
    });
  }
  return undefined;
};

const firstFrame = (bytes: Uint8Array) => {
  for (let offset = id3Length(bytes); offset + 4 <= bytes.length; offset++) {
    const frame = mp3Frame(bytes, offset);
    if (frame !== undefined) return { offset, frame };
  }
  return undefined;
};

export const readMp3Info = (bytes: Uint8Array) => {
  const first = firstFrame(bytes);
  if (first === undefined || first.offset + first.frame.length > bytes.length) return undefined;

  const tagged = ["Xing", "Info"].includes(latin1(bytes, first.frame.tagOffset, 4));
  const gapless =
    (tagged ? lameGapless(bytes, first.frame) : undefined) ??
    itunesGapless(bytes) ??
    new Gapless({ delay: 0, frames: undefined });

  return new SourceInfo({
    codec: "mp3",
    sampleRate: first.frame.sampleRate,
    dataOffset: tagged ? first.offset + first.frame.length : first.offset,
    delay: gapless.delay,
    frames: gapless.frames,
    prefix: new Uint8Array(0),
  });
};

// Decoding starts this many frames early: the bit reservoir reaches up to 511 bytes back, and each
// frame overlaps the previous one
const prerollFrames = 16;

// MP3 frames have no time stamp, so the walk counts the frames before the target
export const mp3SeekPoint = (bytes: Uint8Array, info: SourceInfo, target: number) => {
  const offsets: Array<number> = [];
  let samples = 0;
  let offset = info.dataOffset;

  while (offset + 4 <= bytes.length) {
    const frame = mp3Frame(bytes, offset);
    if (frame === undefined) {
      offset += 1;
      continue;
    }
    if (offset + frame.length > bytes.length) break;
    if (offsets.length * frame.samples > target + info.delay) break;

    offsets.push(offset);
    samples = frame.samples;
    offset += frame.length;
  }
  if (offsets.length === 0) return undefined;

  const start = Math.max(0, offsets.length - 1 - prerollFrames);
  return new SeekPoint({
    prefix: new Uint8Array(0),
    offset: offsets[start]!,
    frame: start * samples - info.delay,
  });
};
