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
// Shared, so that a tile that scrolls back shows its cover at once. A cache holds one reference to
// each image and each user holds its own. Home has about 120 covers, at 256 KB each. A full cover
// can have 6 MB.
const caches = {
  thumbnail: { covers: new Map<string, Artwork | Promise<Artwork>>(), limit: 200 },
  full: { covers: new Map<string, Artwork | Promise<Artwork>>(), limit: 4 },
};

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

const cacheOf = (thumbnail: boolean) => (thumbnail ? caches.thumbnail : caches.full);

const cachedCover = (url: string, thumbnail: boolean) => {
  const { covers, limit } = cacheOf(thumbnail);
  const cached = covers.get(url);
  if (cached !== undefined) {
    // The most recently used cover goes last, so that the oldest goes first
    covers.delete(url);
    covers.set(url, cached);
    return cached;
  }

  const loading = NativeImage.load(url).then((image) => {
    const shown = thumbnail ? shrunk(image) : image;
    const artwork = new Artwork({ image: shown, accent: artworkAccent(shown) });
    // `set` keeps the place of the key in the order
    if (covers.get(url) === loading) covers.set(url, artwork);
    return artwork;
  });
  // A failed load tries again the next time
  loading.catch(() => covers.get(url) === loading && covers.delete(url));
  covers.set(url, loading);

  for (const [oldest, evicted] of [...covers].slice(0, Math.max(0, covers.size - limit))) {
    covers.delete(oldest);
    // Users that wait for a cover that still loads take their reference first
    if (evicted instanceof Artwork) evicted.image.dispose();
    else
      evicted.then(
        (artwork) => artwork.image.dispose(),
        () => {},
      );
  }
  return loading;
};

/**
 * The previous cover stays until the next one loads. A `thumbnail` is small enough for a tile and
 * costs much less to draw.
 */
export function useArtwork(url: string | null, thumbnail = false) {
  const own = (cover: Artwork) => new Artwork({ ...cover, image: cover.image.retain() });
  const [artwork, setArtwork] = useState(() => {
    const initial = url === null ? undefined : cacheOf(thumbnail).covers.get(url);
    return initial instanceof Artwork ? own(initial) : null;
  });
  // The cover that `artwork` shows, so that the first effect does not load it again
  const held = useRef(artwork === null ? null : url);

  useEffect(() => {
    if (url === null) {
      held.current = null;
      setArtwork(null);
      return;
    }
    const cover = cachedCover(url, thumbnail);
    if (held.current === url) return;
    const show = (ready: Artwork) => {
      held.current = url;
      setArtwork(own(ready));
    };
    if (cover instanceof Artwork) {
      show(cover);
      return;
    }
    const state = { current: true };
    cover.then(
      (ready) => state.current && show(ready),
      () => state.current && setArtwork(null),
    );
    return () => {
      state.current = false;
    };
  }, [url, thumbnail]);

  useEffect(() => () => artwork?.image.dispose(), [artwork]);

  return artwork;
}
