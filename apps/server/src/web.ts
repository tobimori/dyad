import { Effect, Layer, Path, Predicate, Schema } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpStaticServer,
} from "effect/unstable/http";

import { ServerConfig } from "./config.ts";

class WebApplicationError extends Schema.TaggedError<WebApplicationError>()("WebApplicationError", {
  cause: Schema.Unknown,
}) {}

export const webApplicationLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { appEnv } = yield* ServerConfig;
    if (appEnv === "development") {
      return Layer.empty;
    }

    const web = yield* Effect.tryPromise({
      try: () => import("@dyad/web/server"),
      catch: (cause) => new WebApplicationError({ cause }),
    });
    const path = yield* Path.Path;
    const root = yield* path.fromFileUrl(web.clientAssetsUrl);
    const staticAssets = yield* HttpStaticServer.make({ root, index: undefined });
    const startHandler = Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const webRequest = yield* HttpServerRequest.toWeb(request);
      const response = yield* Effect.tryPromise({
        try: () => Promise.resolve(web.default.fetch(webRequest)),
        catch: (cause) => new WebApplicationError({ cause }),
      });
      return HttpServerResponse.fromWeb(response);
    });

    return HttpRouter.add(
      "*",
      "*",
      staticAssets.pipe(
        Effect.catchIf(
          (error) => Predicate.isTagged(error.reason, "RouteNotFound"),
          () => startHandler,
        ),
      ),
    );
  }),
);
