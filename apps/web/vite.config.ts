import { HttpUrl } from "@dyad/domain";
import stylex from "@stylexjs/unplugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { Config, ConfigProvider, Effect, Option } from "effect";
import { Url } from "effect/unstable/http";
import { defineConfig, loadEnv } from "vite-plus";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), ["VITE_", "PORT", "DYAD_"]);
  const settings = Effect.runSync(
    Config.all({
      serverUrl: Config.option(Config.schema(HttpUrl, "VITE_DYAD_SERVER_URL")),
      localUrl: Config.option(Config.schema(HttpUrl, "PORTLESS_URL")),
      tailscaleUrl: Config.option(Config.schema(HttpUrl, "PORTLESS_TAILSCALE_URL")),
      port: Config.Port("PORT").pipe(Config.withDefault(4311)),
      apiPort: Config.Port("DYAD_PORT").pipe(Config.withDefault(4310)),
    }).parse(ConfigProvider.fromUnknown(env)),
  );
  const defaultServerUrl = Option.match(settings.localUrl, {
    onNone: () => `http://127.0.0.1:${settings.apiPort}`,
    onSome: (url) =>
      Url.setHostname(url, url.hostname.replace(/(^|\.)dyad(?=\.)/, "$1api.dyad")).origin,
  });
  const serverUrl = Option.match(settings.serverUrl, {
    onNone: () => (mode === "development" ? defaultServerUrl : ""),
    onSome: (url) => url.origin,
  });
  const define = { "import.meta.env.VITE_DYAD_SERVER_URL": JSON.stringify(serverUrl) };

  return {
    plugins: [tanstackStart(), stylex.vite({ useCSSLayers: true }), react()],
    define,
    worker: {
      plugins: () => [{ name: "dyad-worker-config", config: () => ({ define }) }],
    },
    server: {
      host: "127.0.0.1",
      port: settings.port,
      strictPort: true,
      allowedHosts: [settings.localUrl, settings.tailscaleUrl].flatMap((url) =>
        Option.isSome(url) ? [url.value.hostname] : [],
      ),
    },
  };
});
