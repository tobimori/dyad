import { NativeImage } from "@opentui/core";
import { Data } from "effect";
import { useEffect, useRef, useState } from "react";

import { artworkAccent } from "../theme/theme.ts";

export class Artwork extends Data.Class<{
  readonly image: NativeImage;
  readonly accent: ReturnType<typeof artworkAccent>;
}> {}

// The terminal gets each image as PNG. A full cover of 1200 pixels costs 50 ms to encode, a tile
// cover of 256 pixels 4 ms.
const thumbnailPixels = 256;
// Home has about 120 covers, at 256 KB each. A full cover can have 6 MB.
const cacheLimits = { thumbnail: 200, full: 4 };

// Shared, so that a tile that scrolls back shows its cover at once
const loads = new Map<string, Promise<Artwork>>();
const loaded = new Map<string, Artwork>();

const shrunk = (image: NativeImage) => {
  const scale = thumbnailPixels / Math.max(image.width, image.height);
  if (scale >= 1) return image;
  const small = image.resize({
    width: Math.round(image.width * scale),
    height: Math.round(image.height * scale),
  });
  image.dispose();
  return small;
};

const cachedCover = (url: string, thumbnail: boolean) => {
  const kind = thumbnail ? "thumbnail" : "full";
  const key = `${kind}:${url}`;
  const cached = loads.get(key);
  if (cached !== undefined) {
    // The most recently used cover goes last, so that the oldest goes first
    loads.delete(key);
    loads.set(key, cached);
    return cached;
  }

  const loading = NativeImage.load(url).then((image) => {
    const shown = thumbnail ? shrunk(image) : image;
    const artwork = new Artwork({ image: shown, accent: artworkAccent(shown) });
    if (loads.has(key)) loaded.set(key, artwork);
    return artwork;
  });
  // A failed load tries again the next time
  loading.catch(() => loads.delete(key));
  loads.set(key, loading);

  const ofKind = [...loads.keys()].filter((other) => other.startsWith(`${kind}:`));
  for (const oldest of ofKind.slice(0, Math.max(0, ofKind.length - cacheLimits[kind]))) {
    loads.delete(oldest);
    // Each user of the image holds its own reference
    loaded.get(oldest)?.image.dispose();
    loaded.delete(oldest);
  }
  return loading;
};

/**
 * The previous cover stays until the next one loads. A `thumbnail` is small enough for a tile and
 * costs much less to draw.
 */
export function useArtwork(url: string | null, thumbnail = false) {
  const keyOf = (from: string) => `${thumbnail ? "thumbnail" : "full"}:${from}`;
  const own = (cover: Artwork) => new Artwork({ ...cover, image: cover.image.retain() });
  const initial = url === null ? undefined : loaded.get(keyOf(url));
  const [artwork, setArtwork] = useState(() => (initial === undefined ? null : own(initial)));
  // The cover that `artwork` shows, so that the first effect does not load it again
  const held = useRef(initial === undefined || url === null ? null : keyOf(url));

  useEffect(() => {
    if (url === null) {
      held.current = null;
      setArtwork(null);
      return;
    }
    const key = keyOf(url);
    const loading = cachedCover(url, thumbnail);
    if (held.current === key) return;
    const show = (cover: Artwork) => {
      held.current = key;
      setArtwork(own(cover));
    };
    const ready = loaded.get(key);
    if (ready !== undefined) {
      show(ready);
      return;
    }
    const state = { current: true };
    loading.then(
      (cover) => state.current && show(cover),
      () => state.current && setArtwork(null),
    );
    return () => {
      state.current = false;
    };
  }, [url, thumbnail]);

  useEffect(() => () => artwork?.image.dispose(), [artwork]);

  return artwork;
}
