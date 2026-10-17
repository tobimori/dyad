// `node:ffi` needs a real file, so the single executable extracts its assets before OpenTUI loads.
// OpenTUI 0.6.6 resolves its native library in a top-level await, so this module must be the first
// import of `main.tsx`.
// @effect-diagnostics nodeBuiltinImport:off -- this runs before the Effect runtime and OpenTUI start
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAssetKeys, getRawAsset, isSea } from "node:sea";
import envPaths from "env-paths";

declare const DYAD_SEA_ASSET_HASH: string;

if (isSea()) {
  const parent = join(envPaths("dyad", { suffix: "" }).cache, "sea");
  // The folder name is the content hash, so a new build never uses files of an old build
  const root = join(parent, DYAD_SEA_ASSET_HASH);

  if (!existsSync(root) && existsSync(parent)) {
    // A running old build keeps its loaded library when its file is removed. Another process of
    // this build can already write to `root`.
    for (const entry of readdirSync(parent)) {
      if (entry === DYAD_SEA_ASSET_HASH) continue;
      rmSync(join(parent, entry), { recursive: true, force: true });
    }
  }

  for (const key of getAssetKeys()) {
    const target = join(root, key);
    if (existsSync(target)) continue;

    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // Two processes can start at the same time, so each writes its own file and renames it
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, new Uint8Array(getRawAsset(key)), { mode: 0o600 });
    renameSync(temporary, target);
  }

  process.env.OTUI_ASSET_ROOT = root;
}
