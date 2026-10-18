import { Data, Effect, Option, Stream } from "effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import { AppleMusicError } from "./api.ts";

class Segment extends Data.Class<{
  readonly url: string;
  /** HTTP `Range` header value. None reads the whole resource. */
  readonly range: Option.Option<string>;
  /** Where the segment ends in the song. `null` for the init section. */
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
// it is one fragmented MP4 file. DRM tags are read by `widevine.ts`.
const parseSegments = (playlistUrl: string, playlist: string) => {
  const segments: Array<Segment> = [];
  let range = Option.none<string>();
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
          range:
            initRange === undefined ? Option.none() : Option.some(byteRange(initRange, 0).header),
          endMs: null,
        }),
      );
      continue;
    }

    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      const parsed = byteRange(line.slice("#EXT-X-BYTERANGE:".length), previousEnd);
      previousEnd = parsed.end;
      range = Option.some(parsed.header);
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      durationMs = Number.parseFloat(line.slice("#EXTINF:".length)) * 1000;
      continue;
    }

    if (line === "" || line.startsWith("#")) continue;

    endMs += durationMs;
    segments.push(new Segment({ url: new URL(line, playlistUrl).href, range, endMs }));
    range = Option.none();
  }

  return segments;
};

export const readSegments = (playlistUrl: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const playlist = yield* client.get(playlistUrl).pipe(
      Effect.flatMap((response) => response.text),
      Effect.mapError(
        () => new AppleMusicError({ stage: "playlist", reason: "Cannot read the asset playlist" }),
      ),
    );

    const segments = parseSegments(playlistUrl, playlist);
    if (segments.length === 0) {
      return yield* new AppleMusicError({ stage: "playlist", reason: "No media segments" });
    }
    return segments;
  });

/** Downloads the segments one after another, as one continuous stream */
export const segmentBytes = (segments: ReadonlyArray<Segment>) =>
  Stream.fromIterable(segments).pipe(
    Stream.flatMap((segment) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
          const request = Option.match(segment.range, {
            onNone: () => HttpClientRequest.get(segment.url),
            onSome: (range) =>
              HttpClientRequest.get(segment.url).pipe(HttpClientRequest.setHeader("Range", range)),
          });
          const response = yield* client.execute(request);
          return response.stream;
        }),
      ),
    ),
    // Errors contain the signed segment URL
    Stream.mapError(
      () => new AppleMusicError({ stage: "segments", reason: "Cannot read an audio segment" }),
    ),
  );
