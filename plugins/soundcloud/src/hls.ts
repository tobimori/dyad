import { getText, send } from "@dyad/plugin/http";
import { Data, Effect, Stream } from "effect";
import { HttpClientRequest } from "effect/http";

class Segment extends Data.Class<{
  readonly url: string;
  /** Where the segment ends in the track. `null` for the init section. */
  readonly endMs: number | null;
}> {}

// SoundCloud media playlists (October 2026) have one `EXT-X-MAP` init section and media segments
// without byte ranges. The init section and the segments in playlist order are one fragmented MP4
// file.
const parseSegments = (playlistUrl: string, playlist: string) => {
  const segments: Array<Segment> = [];
  let durationMs = 0;
  let endMs = 0;

  for (const line of playlist.split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      if (uri !== undefined) {
        segments.push(new Segment({ url: new URL(uri, playlistUrl).href, endMs: null }));
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      durationMs = Number.parseFloat(line.slice("#EXTINF:".length)) * 1000;
      continue;
    }

    if (line === "" || line.startsWith("#")) continue;

    endMs += durationMs;
    segments.push(new Segment({ url: new URL(line, playlistUrl).href, endMs }));
  }

  return segments;
};

/** The init section and the media segments, in playlist order */
export const readSegments = (playlistUrl: string) =>
  Effect.map(getText(HttpClientRequest.get(playlistUrl)), (playlist) =>
    parseSegments(playlistUrl, playlist),
  );

/** Downloads the segments one after another, as one continuous stream */
export const segmentBytes = (segments: ReadonlyArray<Segment>) =>
  Stream.fromIterable(segments).pipe(
    Stream.flatMap((segment) =>
      Stream.unwrap(
        Effect.map(send(HttpClientRequest.get(segment.url)), (response) => response.stream),
      ),
    ),
  );
