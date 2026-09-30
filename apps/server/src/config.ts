import { HttpUrl } from "@dyad/domain";
import { Config, Context, Effect, Layer, Option, Path } from "effect";
import { Url } from "effect/unstable/http";
import envPaths from "env-paths";

const configuration = Effect.gen(function* () {
  const primaryPort = yield* Config.option(Config.Port("PORT"));
  const port = yield* Option.match(primaryPort, {
    onSome: Effect.succeed,
    onNone: () => Config.Port("DYAD_PORT").pipe(Config.withDefault(4310)),
  });
  const values = yield* Config.all({
    allowedOrigins: Config.Array(HttpUrl, "DYAD_ALLOWED_ORIGINS").pipe(
      Config.map((urls) => urls.map((url) => url.origin)),
      Config.withDefault(["http://127.0.0.1:4311"]),
    ),
    publicUrl: Config.option(Config.schema(HttpUrl, "PORTLESS_URL")),
    appEnv: Config.Literals(["development", "production"], "APP_ENV").pipe(
      Config.withDefault("production"),
    ),
    dataDirectory: Config.NonEmptyString("DYAD_DATA_DIR").pipe(
      Config.withDefault(envPaths("dyad", { suffix: "" }).data),
    ),
  });
  const allowedOrigins = [...values.allowedOrigins];
  if (Option.isSome(values.publicUrl)) {
    const url = values.publicUrl.value;
    const webUrl = Url.setHostname(url, url.hostname.replace(/(^|\.)api\.dyad(?=\.)/, "$1dyad"));
    allowedOrigins.push(url.origin, webUrl.origin);
  }
  const path = yield* Path.Path;
  return {
    appEnv: values.appEnv,
    port,
    allowedOrigins: [...new Set(allowedOrigins)],
    dataDirectory: path.resolve(values.dataDirectory),
  };
});

type ServerConfigValues = Effect.Success<typeof configuration>;

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigValues>()(
  "@dyad/server/ServerConfig",
) {
  static readonly layer = Layer.effect(ServerConfig, configuration);

  static configLayer(values: ServerConfigValues) {
    return Layer.succeed(ServerConfig, values);
  }
}
