import { Plugin } from "@dyad/plugin";
import { Effect } from "effect";

import { serve } from "./server.ts";
import type { Login } from "./server.ts";

export { Artwork, Library, MirrorUnavailable, SessionMirror } from "./mirror.ts";
export type { Login } from "./server.ts";

/** Serves the MPD protocol on `listen` to clients on private networks */
export const mpdPlugin = (listen: { readonly host: string; readonly port: number }, login: Login) =>
  new Plugin({
    id: "dyad.mpd",
    setup: () =>
      serve(listen, login).pipe(
        Effect.catch((error) => Effect.logError("The MPD server cannot listen", error)),
        Effect.forkScoped,
        Effect.asVoid,
      ),
  });
