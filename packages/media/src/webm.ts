export const segmentId = 0x18538067;
export const clusterId = 0x1f43b675;

// An EBML variable-length integer: the count of leading zero bits gives its length
const readVint = (bytes: Uint8Array, offset: number, keepMarker: boolean) => {
  const first = bytes[offset];
  if (first === undefined) return undefined;
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8 || offset + length > bytes.length) return undefined;

  let value = keepMarker ? first : first & (0xff >> length);
  let unknown = value === 0xff >> length;
  for (let index = 1; index < length; index++) {
    const byte = bytes[offset + index] ?? 0;
    value = value * 256 + byte;
    unknown &&= byte === 0xff;
  }
  return { value, length, unknown: unknown && !keepMarker };
};

/**
 * The EBML element at `offset`. `undefined` when `bytes` ends in its header or the header is
 * invalid. `end` is `null` for an element of unknown size.
 */
export const readElement = (bytes: Uint8Array, offset: number) => {
  const id = readVint(bytes, offset, true);
  const size = id && readVint(bytes, offset + id.length, false);
  if (id === undefined || size === undefined) return undefined;
  const start = offset + id.length + size.length;
  return { id: id.value, start, end: size.unknown ? null : start + size.value };
};
