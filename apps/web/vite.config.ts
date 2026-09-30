import stylex from "@stylexjs/unplugin";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite-plus";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  const localServerUrl = process.env.PORTLESS_URL
    ? new URL(process.env.PORTLESS_URL)
    : new URL(`http://127.0.0.1:${process.env.DYAD_PORT ?? 4310}`);
  if (process.env.PORTLESS_URL) {
    localServerUrl.hostname = localServerUrl.hostname.replace(/(^|\.)dyad(?=\.)/, "$1api.dyad");
  }

  return {
    plugins: [tanstackStart(), stylex.vite({ useCSSLayers: true }), react()],
    define: {
      "import.meta.env.VITE_DYAD_SERVER_URL": JSON.stringify(
        env.VITE_DYAD_SERVER_URL ?? (mode === "development" ? localServerUrl.origin : ""),
      ),
    },
    server: {
      host: "127.0.0.1",
      port: Number(process.env.PORT ?? 4311),
      strictPort: true,
      allowedHosts: [process.env.PORTLESS_URL, process.env.PORTLESS_TAILSCALE_URL].flatMap((url) =>
        url ? [new URL(url).hostname] : [],
      ),
    },
  };
});
