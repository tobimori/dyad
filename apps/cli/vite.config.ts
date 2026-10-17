import { defineConfig } from "vite-plus";

export default defineConfig({
  pack: {
    entry: ["src/main.tsx"],
    platform: "node",
    target: "node26",
    format: ["esm"],
    sourcemap: true,
    deps: { alwaysBundle: [/^@dyad\//] },
  },
});
