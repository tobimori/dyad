import { Data, Effect, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

import { getText, send } from "./http.ts";

class Segment extends Data.Class<{
  readonly url: string;
  /** HTTP `Range` header value. `null` reads the whole resource. */
  readonly range: string | null;
  /** Where the segment ends in the track. `null` for the init section. */
  readonly endMs: number | null;
}> {}

// Quoted values can contain commas
const attribute = (line: string, name: string) => {
  const match = line.match(new RegExp(`[:,]${name}=(?:"([^"]*)"|([^,]*))`));
  return match?.[1] ?? match?.[2];
};

// `<length>[@<offset>]`. Without an offset, the range starts after the previous media segment.
const byteRange = (value: string, previousEnd: number) => {
  const [length, offset] = value.split("@");
  const start = offset === undefined ? previousEnd : Number(offset);
  const end = start + Number(length);
  return { end, header: `bytes=${start}-${end - 1}` };
};

// The `EXT-X-MAP` init section comes first. Together with the media segments in playlist order,
// it is one fragmented MP4 file.
const parseSegments = (playlistUrl: string, playlist: string) => {
  const segments: Array<Segment> = [];
  let range: string | null = null;
  let previousEnd = 0;
  let durationMs = 0;
  let endMs = 0;

  for (const line of playlist.split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = attribute(line, "URI");
      if (uri === undefined) continue;

      const initRange = attribute(line, "BYTERANGE");
      segments.push(
        new Segment({
          url: new URL(uri, playlistUrl).href,
          range: initRange === undefined ? null : byteRange(initRange, 0).header,
          endMs: null,
        }),
      );
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const parsed = byteRange(line.slice("#EXT-X-BYTERANGE:".length), previousEnd);
      previousEnd = parsed.end;
      range = parsed.header;
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      durationMs = Number.parseFloat(line.slice("#EXTINF:".length)) * 1000;
      continue;
    }

    if (line === "" || line.startsWith("#")) continue;

    endMs += durationMs;
    segments.push(new Segment({ url: new URL(line, playlistUrl).href, range, endMs }));
    range = null;
  }

  return segments;
};

/** The init section and the media segments of an HLS media playlist of fragmented MP4 */
export const readSegments = (playlistUrl: string) =>
  Effect.map(getText(HttpClientRequest.get(playlistUrl)), (playlist) =>
    parseSegments(playlistUrl, playlist),
  );

/** Downloads the segments one after another, as one continuous stream. Errors contain the URL. */
export const segmentBytes = (segments: ReadonlyArray<Segment>) =>
  Stream.fromIterable(segments).pipe(
    Stream.flatMap((segment) => {
      const request = HttpClientRequest.get(segment.url);
      return Stream.unwrap(
        Effect.map(
          send(
            segment.range === null
              ? request
              : HttpClientRequest.setHeader(request, "Range", segment.range),
          ),
          (response) => response.stream,
        ),
      );
    }),
  );

/** The init section and the segments that end after `startMs` */
export const segmentsFrom = (segments: ReadonlyArray<Segment>, startMs: number) =>
  segments.filter((segment) => segment.endMs === null || segment.endMs > startMs);
