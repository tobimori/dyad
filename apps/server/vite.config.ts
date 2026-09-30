import { defineConfig } from "vite-plus";

export default defineConfig({
  run: {
    tasks: {
      build: {
        command: "vp pack",
        dependsOn: ["@dyad/db#build", "@dyad/web#build"],
        cache: false,
      },
    },
  },
  pack: {
    entry: ["src/main.ts"],
    platform: "node",
    target: "node24",
    format: ["esm"],
    sourcemap: true,
    deps: { alwaysBundle: [/^@dyad\/(?:domain|server-core)(?:\/|$)/] },
  },
});
