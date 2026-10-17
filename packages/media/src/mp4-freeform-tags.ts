import { Effect, Schema } from "effect";

// Mediabunny 1.61.0 keeps only the first MP4 freeform atom (`----`) and does not read its
// `mean` and `name` boxes. Picard stores MusicBrainz IDs and ISRC in these atoms.

export class Mp4MetadataError extends Schema.TaggedError<Mp4MetadataError>()("Mp4MetadataError", {
  reason: Schema.String,
}) {}

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
}

const iTunesNamespace = "com.apple.iTunes";
const utf8DataType = 1;
const latin1 = new TextDecoder("latin1");
const utf8 = new TextDecoder("utf-8");

const readSlice = (blob: Blob, start: number, end: number) =>
  Effect.tryPromise({
    try: () => blob.slice(start, end).arrayBuffer(),
    catch: () => new Mp4MetadataError({ reason: `Cannot read bytes ${start} to ${end}` }),
  }).pipe(Effect.map((buffer) => new Uint8Array(buffer)));

const readBoxType = (bytes: Uint8Array, offset: number) =>
  latin1.decode(bytes.subarray(offset, offset + 4));

// Box headers use a 32-bit size, a 64-bit size when the size is 1, or the parent end when it is 0
const readBoxHeader = (bytes: Uint8Array, offset: number, parentEnd: number) => {
  if (offset + 8 > bytes.byteLength) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size32 = view.getUint32(offset);
  const type = readBoxType(bytes, offset + 4);
  if (size32 === 1) {
    if (offset + 16 > bytes.byteLength) return undefined;
    return { type, headerSize: 16, size: Number(view.getBigUint64(offset + 8)) };
  }
  return { type, headerSize: 8, size: size32 === 0 ? parentEnd - offset : size32 };
};

function* children(bytes: Uint8Array, start: number, end: number) {
  let offset = start;
  while (offset + 8 <= end) {
    const header = readBoxHeader(bytes, offset, end);
    if (header === undefined || header.size < header.headerSize || offset + header.size > end) {
      return;
    }
    const box: Box = {
      type: header.type,
      start: offset + header.headerSize,
      end: offset + header.size,
    };
    yield box;
    offset += header.size;
  }
}

const findChild = (bytes: Uint8Array, parent: Box, type: string) => {
  for (const box of children(bytes, parent.start, parent.end)) {
    if (box.type === type) return box;
  }
  return undefined;
};

// ISO `meta` is a full box with 4 bytes of version and flags. QuickTime `meta` has none.
const metaContent = (bytes: Uint8Array, meta: Box) =>
  readBoxType(bytes, meta.start + 4) === "hdlr" ? meta : { ...meta, start: meta.start + 4 };

const readFreeformAtom = (bytes: Uint8Array, atom: Box) => {
  let mean: string | undefined;
  let name: string | undefined;
  const values: Array<string> = [];
  for (const box of children(bytes, atom.start, atom.end)) {
    // `mean` and `name` are full boxes; `data` has a 4-byte type and a 4-byte locale
    if (box.type === "mean") mean = utf8.decode(bytes.subarray(box.start + 4, box.end));
    if (box.type === "name") name = utf8.decode(bytes.subarray(box.start + 4, box.end));
    if (box.type === "data" && box.end - box.start >= 8) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + box.start, 8);
      if ((view.getUint32(0) & 0xffffff) === utf8DataType) {
        values.push(utf8.decode(bytes.subarray(box.start + 8, box.end)));
      }
    }
  }
  if (mean === undefined || name === undefined) return undefined;
  return { key: mean === iTunesNamespace ? name : `${mean}:${name}`, values };
};

const findTopLevelBox = Effect.fn("findTopLevelBox")(function* (blob: Blob, type: string) {
  let offset = 0;
  while (offset + 8 <= blob.size) {
    const bytes = yield* readSlice(blob, offset, Math.min(offset + 16, blob.size));
    const header = readBoxHeader(bytes, 0, blob.size - offset);
    if (header === undefined || header.size < header.headerSize) {
      return yield* new Mp4MetadataError({ reason: `Invalid box header at ${offset}` });
    }
    if (header.type === type) {
      return { start: offset + header.headerSize, end: Math.min(offset + header.size, blob.size) };
    }
    offset += header.size;
  }
  return undefined;
});

/**
 * Read MP4 freeform (`----`) text atoms from `moov/udta/meta/ilst` or `moov/meta/ilst`.
 * Keys are the atom names for the `com.apple.iTunes` namespace, else `<mean>:<name>`.
 * Only the `moov` box is loaded into memory.
 */
export const readMp4FreeformTags = Effect.fn("readMp4FreeformTags")(function* (blob: Blob) {
  const tags = new Map<string, ReadonlyArray<string>>();
  const moovRange = yield* findTopLevelBox(blob, "moov");
  if (moovRange === undefined) return tags;

  const bytes = yield* readSlice(blob, moovRange.start, moovRange.end);
  const moov = { type: "moov", start: 0, end: bytes.byteLength };
  const udta = findChild(bytes, moov, "udta");
  const meta =
    (udta === undefined ? undefined : findChild(bytes, udta, "meta")) ??
    findChild(bytes, moov, "meta");
  if (meta === undefined) return tags;

  const ilst = findChild(bytes, metaContent(bytes, meta), "ilst");
  if (ilst === undefined) return tags;

  for (const atom of children(bytes, ilst.start, ilst.end)) {
    if (atom.type !== "----") continue;
    const tag = readFreeformAtom(bytes, atom);
    if (tag !== undefined) tags.set(tag.key, [...(tags.get(tag.key) ?? []), ...tag.values]);
  }
  return tags;
});
