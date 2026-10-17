import { NativeImage } from "@opentui/core";
import { Data, Effect, Fiber } from "effect";
import { useEffect, useState } from "react";

import { artworkAccent } from "./theme.ts";

export class Artwork extends Data.Class<{
  readonly image: NativeImage;
  readonly accent: ReturnType<typeof artworkAccent>;
}> {}

/** Loads the cover of the current source. The previous cover stays until the next one loads. */
export function useArtwork(url: string | null) {
  const [artwork, setArtwork] = useState<Artwork | null>(null);

  useEffect(() => {
    if (url === null) {
      setArtwork(null);
      return;
    }

    const fiber = Effect.runFork(
      Effect.tryPromise((signal) => NativeImage.load(url, { signal })).pipe(
        Effect.match({
          onFailure: () => setArtwork(null),
          onSuccess: (image) => setArtwork(new Artwork({ image, accent: artworkAccent(image) })),
        }),
      ),
    );
    return () => {
      Effect.runFork(Fiber.interrupt(fiber));
    };
  }, [url]);

  // `ImageRenderable` holds its own reference, so this one can go when the next cover replaces it
  useEffect(() => () => artwork?.image.dispose(), [artwork]);

  return artwork;
}
