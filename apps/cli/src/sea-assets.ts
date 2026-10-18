// @effect-diagnostics nodeBuiltinImport:off -- this runs before the Effect runtime and OpenTUI start
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAssetKeys, getRawAsset, isSea } from "node:sea";
import envPaths from "env-paths";

declare const DYAD_SEA_ASSET_HASH: string;

const parent = join(envPaths("dyad", { suffix: "" }).cache, "sea");

/**
 * The folder of the extracted assets, `null` outside the executable. Its name is the content hash,
 * so a new build never uses files of an old build.
 */
export const seaAssetRoot = isSea() ? join(parent, DYAD_SEA_ASSET_HASH) : null;

// `node:ffi` needs a real file, so the executable extracts its assets before OpenTUI loads
if (seaAssetRoot !== null) {
  if (!existsSync(seaAssetRoot) && existsSync(parent)) {
    // A running old build keeps its loaded library when its file is removed. Another process of
    // this build can already write to `seaAssetRoot`.
    for (const entry of readdirSync(parent)) {
      if (entry === DYAD_SEA_ASSET_HASH) continue;
      rmSync(join(parent, entry), { recursive: true, force: true });
    }
  }

  for (const key of getAssetKeys()) {
    const target = join(seaAssetRoot, key);
    if (existsSync(target)) continue;

    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    // Two processes can start at the same time, so each writes its own file and renames it
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, new Uint8Array(getRawAsset(key)), { mode: 0o600 });
    renameSync(temporary, target);
  }

  process.env.OTUI_ASSET_ROOT = seaAssetRoot;
}
