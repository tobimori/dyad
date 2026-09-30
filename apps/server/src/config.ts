import { Config, Context, Effect, Layer, Path } from "effect";
import envPaths from "env-paths";

const configuration = Config.all({
  allowedOrigins: Config.String("DYAD_ALLOWED_ORIGINS").pipe(
    Config.withDefault("http://127.0.0.1:4311"),
    Config.map((value) => value.split(",").map((origin) => new URL(origin.trim()).origin)),
  ),
  publicUrl: Config.String("PORTLESS_URL").pipe(Config.withDefault("")),
  appEnv: Config.Literals(["development", "production"], "APP_ENV").pipe(
    Config.withDefault("production"),
  ),
  dataDirectory: Config.String("DYAD_DATA_DIR").pipe(
    Config.withDefault(envPaths("dyad", { suffix: "" }).data),
  ),
  port: Config.Port("PORT").pipe(
    Config.orElse(() => Config.Port("DYAD_PORT")),
    Config.withDefault(4310),
  ),
});

type ServerConfigValues = Config.Success<typeof configuration>;

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigValues>()(
  "@dyad/server/ServerConfig",
) {
  static readonly layer = Layer.effect(
    ServerConfig,
    Effect.gen(function* resolveServerConfig() {
      const values = yield* configuration;
      const path = yield* Path.Path;
      const allowedOrigins = [...values.allowedOrigins];
      if (values.publicUrl) {
        const webUrl = new URL(values.publicUrl);
        allowedOrigins.push(webUrl.origin);
        webUrl.hostname = webUrl.hostname.replace(/(^|\.)api\.dyad(?=\.)/, "$1dyad");
        allowedOrigins.push(webUrl.origin);
      }
      return { ...values, allowedOrigins, dataDirectory: path.resolve(values.dataDirectory) };
    }),
  );

  static configLayer(values: ServerConfigValues) {
    return Layer.succeed(ServerConfig, values);
  }
}
