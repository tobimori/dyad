// @effect-diagnostics nodeBuiltinImport:off -- Vite+ loads this config outside an Effect runtime
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { getNodeAssets } from "@opentui/core/node-assets";
import { Effect, Schema } from "effect";
import { defineConfig } from "vite-plus";
import { build } from "vite-plus/pack";

const targets = {
  "linux-x64": { platform: "linux", arch: "x64", library: ".so" },
  "linux-arm64": { platform: "linux", arch: "arm64", library: ".so" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", library: ".dylib" },
} as const;

// A target builds one executable. No target builds `dist/main.mjs` for Node with `node_modules`.
const target = Schema.decodeUnknownSync(
  Schema.UndefinedOr(Schema.Literals(["linux-x64", "linux-arm64", "darwin-arm64"])),
)(process.env.DYAD_EXE_TARGET);

// The video worker loads the libav.js factory module from a file, and the factory loads the `.wasm`
// next to it
const libavDirectory = dirname(
  createRequire(import.meta.url).resolve("@libav.js/variant-vp9-opus"),
);
const libavAssets = readdirSync(libavDirectory)
  .filter((name) => /\.wasm\.(mjs|wasm)$/.test(name))
  .map((name) => ({ key: `libav/${name}`, source: join(libavDirectory, name) }));

const workerModule = Effect.gen(function* () {
  const { bundles } = yield* Effect.promise(() =>
    build({
      config: false,
      cwd: import.meta.dirname,
      entry: ["src/video/decoder-worker.ts"],
      platform: "node",
      target: "node26",
      // An ES module from a `data:` URL cannot make the `require` that the bundle needs
      format: "cjs",
      minify: true,
      write: false,
      deps: { alwaysBundle: [/./], onlyBundle: false },
      logLevel: "warn",
    }),
  );
  const chunk = bundles[0]?.chunks.find((output) => output.type === "chunk");
  if (chunk?.type !== "chunk") return yield* Effect.die("The video worker build has no output");
  return `export const workerCode = ${JSON.stringify(chunk.code)};`;
});

// An executable holds one file, so the bundled worker becomes a string in it
const videoWorker = {
  name: "dyad-video-worker",
  load: (id: string) =>
    id.endsWith("/src/video/worker-code.ts") ? Effect.runPromise(workerModule) : null,
};

const executable = (name: keyof typeof targets) => {
  const { platform, arch, library } = targets[name];

  // Dyad shows no code or Markdown, so it needs only the native library and no tree-sitter files.
  // Without `libc`, OpenTUI selects the glibc library, like the official Node binaries.
  const assets = [
    ...getNodeAssets({ platform, arch }).filter((asset) => asset.key.endsWith(library)),
    ...libavAssets,
  ];
  const hash = createHash("sha256");
  for (const asset of assets) hash.update(asset.key).update(readFileSync(asset.source));

  return {
    outDir: `dist/${name}`,
    deps: { alwaysBundle: [/./], onlyBundle: false as const },
    define: {
      DYAD_SEA_ASSET_HASH: JSON.stringify(hash.digest("hex").slice(0, 16)),
      "process.env.NODE_ENV": JSON.stringify("production"),
    },
    exe: {
      outDir: `dist/${name}`,
      fileName: "dyad",
      // The builder Node makes the code cache, so the target uses the same version
      targets: [{ platform, arch, nodeVersion: process.versions.node }],
      seaConfig: {
        execArgv: ["--experimental-ffi", "--disable-warning=ExperimentalWarning"],
        execArgvExtension: "none" as const,
        // A code cache works only on the platform that made it
        useCodeCache: platform === process.platform && arch === process.arch,
        assets: Object.fromEntries(assets.map((asset) => [asset.key, asset.source])),
      },
    },
  };
};

export default defineConfig({
  pack: {
    entry: ["src/main.tsx"],
    platform: "node",
    target: "node26",
    format: ["esm"],
    plugins: [videoWorker],
    // Workspace packages export their sources under `development`; their `dist` builds can be stale
    inputOptions: { resolve: { conditionNames: ["development", "node", "import", "default"] } },
    ...(target === undefined
      ? { sourcemap: true, deps: { alwaysBundle: [/^@dyad\//] } }
      : executable(target)),
  },
});
