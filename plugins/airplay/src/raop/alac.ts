export const framesPerPacket = 352;

// Header (23 bits) + 352 stereo frames of 16 bits + end tag (3 bits), padded to whole bytes
const frameBytes = Math.ceil((23 + framesPerPacket * 2 * 16 + 3) / 8);

/**
 * Encodes 352 interleaved stereo 16-bit frames as one uncompressed ALAC frame. All ALAC
 * decoders read this "escape" form, so no compressor is needed.
 */
export const encodeAlac = (samples: Int16Array) => {
  const out = new Uint8Array(frameBytes);
  let bit = 0;

  const write = (value: number, bits: number) => {
    for (let index = bits - 1; index >= 0; index--) {
      if ((value >> index) & 1) out[bit >> 3]! |= 0x80 >> (bit & 7);
      bit++;
    }
  };

  write(1, 3); // channel pair element
  write(0, 4); // element instance
  write(0, 12); // unused
  write(0, 1); // no sample count: the frame has the 352 frames from the SDP
  write(0, 2); // no shifted bytes
  write(1, 1); // uncompressed

  for (const sample of samples) write(sample & 0xffff, 16);

  write(7, 3); // end of frame
  return out;
};
