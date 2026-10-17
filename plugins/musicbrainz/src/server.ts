// Finds MusicBrainz recordings for sources: by ISRC with the MusicBrainz search, and by exact artist
// credit and title with the ListenBrainz labs API. The plugin owns HTTP, pacing and response
// schemas. The core decides which match to accept. Provide `pacingLayer` once per process, because
// the rate limits are per IP.

export { LookupError, Pacing, pacingLayer, RateLimited } from "./http.ts";
export { lookupRecordings, RecordingHit } from "./listenbrainz.ts";
export { IsrcRecording, lookupIsrcs } from "./musicbrainz.ts";
