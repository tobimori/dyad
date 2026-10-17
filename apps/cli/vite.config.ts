// @effect-diagnostics nodeBuiltinImport:off -- Vite+ loads this config outside an Effect runtime
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { getNodeAssets } from "@opentui/core/node-assets";
import { Schema } from "effect";
import { defineConfig } from "vite-plus";

const targets = {
  "linux-x64": { platform: "linux", arch: "x64", library: ".so" },
  "linux-arm64": { platform: "linux", arch: "arm64", library: ".so" },
  "darwin-arm64": { platform: "darwin", arch: "arm64", library: ".dylib" },
} as const;

// A target builds one executable. No target builds `dist/main.mjs` for Node with `node_modules`.
const target = Schema.decodeUnknownSync(
  Schema.UndefinedOr(Schema.Literals(["linux-x64", "linux-arm64", "darwin-arm64"])),
)(process.env.DYAD_EXE_TARGET);

const executable = (name: keyof typeof targets) => {
  const { platform, arch, library } = targets[name];

  // Dyad shows no code or Markdown, so it needs only the native library and no tree-sitter files.
  // Without `libc`, OpenTUI selects the glibc library, like the official Node binaries.
  const assets = getNodeAssets({ platform, arch }).filter((asset) => asset.key.endsWith(library));
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
    ...(target === undefined
      ? { sourcemap: true, deps: { alwaysBundle: [/^@dyad\//] } }
      : executable(target)),
  },
});
