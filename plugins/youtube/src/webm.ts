const segmentId = 0x18538067;
const cuesId = 0x1c53bb6b;
const clusterId = 0x1f43b675;
const cuePointId = 0xbb;
const cueTimeId = 0xb3;
const cueTrackPositionsId = 0xb7;
const cueClusterPositionId = 0xf1;

// An EBML variable-length integer: the count of leading zero bits gives its length
const readVint = (view: DataView, offset: number, keepMarker: boolean) => {
  const first = view.getUint8(offset);
  const length = Math.clz32(first) - 23;
  if (length < 1 || length > 8) throw new RangeError("Invalid EBML integer");

  let value = keepMarker ? first : first & (0xff >> length);
  for (let index = 1; index < length; index++) value = value * 256 + view.getUint8(offset + index);
  return { value, length };
};

const readElement = (view: DataView, offset: number) => {
  const id = readVint(view, offset, true);
  const size = readVint(view, offset + id.length, false);
  const start = offset + id.length + size.length;
  return { id: id.value, start, end: start + size.value };
};

const children = (view: DataView, start: number, end: number) => {
  const elements = [];
  for (let offset = start; offset < end;) {
    const element = readElement(view, offset);
    elements.push(element);
    offset = element.end;
  }
  return elements;
};

const readUint = (view: DataView, start: number, end: number) => {
  let value = 0;
  for (let offset = start; offset < end; offset++) value = value * 256 + view.getUint8(offset);
  return value;
};

/**
 * The offsets of the `Cues` element, which YouTube puts before the first cluster. Throws when
 * `head` ends before the header of `Cues`.
 */
export const findCues = (head: Uint8Array) => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const header = readElement(view, 0);
  const segment = readElement(view, header.end);
  if (segment.id !== segmentId) throw new RangeError("No WebM segment");

  for (let offset = segment.start; ;) {
    const element = readElement(view, offset);
    if (element.id === cuesId) return { start: offset, end: element.end };
    if (element.id === clusterId) throw new RangeError("No WebM cues before the clusters");
    offset = element.end;
  }
};

/**
 * The file offset of the last cluster that starts at or before `startMs`. `head` is the file from
 * its start to the end of the `Cues` element, which starts at `cuesStart`. Throws on a bad file.
 */
export const clusterOffset = (head: Uint8Array, cuesStart: number, startMs: number) => {
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  // Cue positions are relative to the data of the segment, which follows the EBML header
  const header = readElement(view, 0);
  const segment = readElement(view, header.end);
  if (segment.id !== segmentId) throw new RangeError("No WebM segment");

  const cues = readElement(view, cuesStart);
  // YouTube WebM (October 2026) has the default `TimecodeScale` of 1 ms
  const points = children(view, cues.start, cues.end)
    .filter((element) => element.id === cuePointId)
    .flatMap((point) => {
      const fields = children(view, point.start, point.end);
      const time = fields.find((field) => field.id === cueTimeId);
      const positions = fields.find((field) => field.id === cueTrackPositionsId);
      const cluster =
        positions &&
        children(view, positions.start, positions.end).find(
          (field) => field.id === cueClusterPositionId,
        );
      return time === undefined || cluster === undefined
        ? []
        : [
            {
              timeMs: readUint(view, time.start, time.end),
              position: readUint(view, cluster.start, cluster.end),
            },
          ];
    });

  const point = points.findLast((cue) => cue.timeMs <= startMs) ?? points[0];
  if (point === undefined) throw new RangeError("No WebM cues");
  return segment.start + point.position;
};
