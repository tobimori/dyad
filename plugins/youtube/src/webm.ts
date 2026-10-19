import { clusterId, readElement, segmentId } from "@dyad/media";
import { ProviderError } from "@dyad/plugin";
import { HttpStatusError, providerError, send } from "@dyad/plugin/http";
import { Effect, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

const cuesId = 0x1c53bb6b;
const cuePointId = 0xbb;
const cueTimeId = 0xb3;
const cueTrackPositionsId = 0xb7;
const cueClusterPositionId = 0xf1;

// A request without a bounded range (October 2026) is throttled to about twice real time
const chunkBytes = 10 * 1024 * 1024;

// Enough for the head of most files. A larger `Cues` needs a second read.
const headBytes = 256 * 1024;

const element = (bytes: Uint8Array, offset: number) => {
  const found = readElement(bytes, offset);
  if (found?.end == null) throw new RangeError("Invalid WebM element");
  return { id: found.id, start: found.start, end: found.end };
};

const children = (bytes: Uint8Array, start: number, end: number) => {
  const elements = [];
  for (let offset = start; offset < end;) {
    const child = element(bytes, offset);
    elements.push(child);
    offset = child.end;
  }
  return elements;
};

// The data of the segment follows the EBML header
const segmentStart = (head: Uint8Array) => {
  const segment = readElement(head, element(head, 0).end);
  if (segment?.id !== segmentId) throw new RangeError("No WebM segment");
  return segment.start;
};

const readUint = (bytes: Uint8Array, start: number, end: number) => {
  let value = 0;
  for (let offset = start; offset < end; offset++) value = value * 256 + (bytes[offset] ?? 0);
  return value;
};

// The offsets of the `Cues` element, which YouTube puts before the first cluster. Throws when
// `head` ends before the header of `Cues`.
const findCues = (head: Uint8Array) => {
  for (let offset = segmentStart(head); ;) {
    const child = element(head, offset);
    if (child.id === cuesId) return { start: offset, end: child.end };
    if (child.id === clusterId) throw new RangeError("No WebM cues before the clusters");
    offset = child.end;
  }
};

// The file offset of the last cluster that starts at or before `startMs`. `head` is the file from
// its start to the end of the `Cues` element, which starts at `cuesStart`. Throws on a bad file.
const clusterOffset = (head: Uint8Array, cuesStart: number, startMs: number) => {
  const cues = element(head, cuesStart);
  // YouTube WebM (October 2026) has the default `TimecodeScale` of 1 ms
  const points = children(head, cues.start, cues.end)
    .filter((child) => child.id === cuePointId)
    .flatMap((point) => {
      const fields = children(head, point.start, point.end);
      const time = fields.find((field) => field.id === cueTimeId);
      const positions = fields.find((field) => field.id === cueTrackPositionsId);
      const cluster =
        positions &&
        children(head, positions.start, positions.end).find(
          (field) => field.id === cueClusterPositionId,
        );
      return time === undefined || cluster === undefined
        ? []
        : [
            {
              timeMs: readUint(head, time.start, time.end),
              position: readUint(head, cluster.start, cluster.end),
            },
          ];
    });

  const point = points.findLast((cue) => cue.timeMs <= startMs) ?? points[0];
  if (point === undefined) throw new RangeError("No WebM cues");
  // Cue positions are relative to the data of the segment
  return segmentStart(head) + point.position;
};

export const readChunks = (url: string, start: number, end: number) =>
  Stream.range(0, Math.ceil((end - start) / chunkBytes) - 1).pipe(
    Stream.flatMap((index) => {
      const from = start + index * chunkBytes;
      const to = Math.min(end, from + chunkBytes) - 1;
      return Stream.unwrap(
        Effect.map(
          send(HttpClientRequest.get(`${url}&range=${from}-${to}`)),
          (response) => response.stream,
        ),
      );
    }),
  );

/** Errors contain the signed URL, so this keeps only the status */
export const streamError =
  (kind: "audio" | "video") =>
  <E>(error: E) =>
    error instanceof HttpStatusError
      ? providerError("YouTube")(error)
      : new ProviderError({ reason: `Cannot read the ${kind} stream` });

/**
 * A WebM file of YouTube: the head has the `Cues` index, so a start skips to the cluster before
 * it. Without `cues`, the head shows where `Cues` is. `cues.end` is exclusive.
 */
export const webmStream = Effect.fn("webmStream")(function* (
  url: string,
  contentLength: number,
  kind: "audio" | "video",
  cues: { readonly start: number; readonly end: number } | null,
) {
  const services = yield* Effect.context<HttpClient.HttpClient>();
  const safe = <E>(stream: Stream.Stream<Uint8Array, E, HttpClient.HttpClient>) =>
    stream.pipe(Stream.mapError(streamError(kind)), Stream.provideContext(services));

  const readHead = (end: number) =>
    send(HttpClientRequest.get(`${url}&range=0-${end - 1}`)).pipe(
      Effect.flatMap((response) => response.arrayBuffer),
      Effect.map((buffer) => new Uint8Array(buffer)),
    );

  const readIndex = Effect.gen(function* () {
    if (cues !== null) return { cues, head: yield* readHead(cues.end) };
    const first = yield* readHead(Math.min(headBytes, contentLength));
    const found = yield* Effect.try(() => findCues(first));
    return { cues: found, head: found.end <= first.length ? first : yield* readHead(found.end) };
  });

  const bytesFrom = (startMs: number) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { cues, head } = yield* readIndex;
        const offset = yield* Effect.try(() => clusterOffset(head, cues.start, startMs));
        return Stream.concat(
          Stream.succeed(head.subarray(0, cues.start)),
          readChunks(url, offset, contentLength),
        );
      }),
    ).pipe(safe);

  return { bytes: readChunks(url, 0, contentLength).pipe(safe), bytesFrom };
});
