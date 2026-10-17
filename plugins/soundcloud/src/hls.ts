import { Effect, Stream } from "effect";
import { HttpClient } from "effect/http";

// SoundCloud media playlists (October 2026) have one `EXT-X-MAP` init section and media segments
// without byte ranges. The init section and the segments in playlist order are one fragmented MP4
// file.
const parseSegments = (playlistUrl: string, playlist: string) =>
  playlist.split(/\r?\n/).flatMap((line) => {
    if (line.startsWith("#EXT-X-MAP:")) {
      const uri = line.match(/URI="([^"]+)"/)?.[1];
      return uri === undefined ? [] : [new URL(uri, playlistUrl).href];
    }

    if (line === "" || line.startsWith("#")) return [];

    return [new URL(line, playlistUrl).href];
  });

/** URLs of the init section and the media segments, in playlist order */
export const readSegments = (playlistUrl: string) =>
  Effect.gen(function* () {
    const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
    const response = yield* client.get(playlistUrl);
    const playlist = yield* response.text;

    return parseSegments(playlistUrl, playlist);
  });

/** Downloads the segments one after another, as one continuous stream */
export const segmentBytes = (urls: ReadonlyArray<string>) =>
  Stream.fromIterable(urls).pipe(
    Stream.flatMap((url) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const client = HttpClient.filterStatusOk(yield* HttpClient.HttpClient);
          const response = yield* client.get(url);
          return response.stream;
        }),
      ),
    ),
  );
