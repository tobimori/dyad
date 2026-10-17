// @effect-diagnostics nodeBuiltinImport:off -- runs before `vp i`, so only Node built-ins exist
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Git ignores these, so a new worktree does not have them
const LINKED_PATHS = [".docs"];

const projectRoot = process.env.T3CODE_PROJECT_ROOT;
if (!projectRoot) {
  throw new Error("T3CODE_PROJECT_ROOT is not set. Run this through the t3.json setup script.");
}
const worktree = NodePath.dirname(import.meta.dirname);

// Nobody answers prompts during setup, so stdin stays closed. A stale lockfile must fail setup
// instead of resolving new versions.
const install = NodeChildProcess.spawnSync("vp i --frozen-lockfile -- --yes", {
  cwd: worktree,
  shell: true,
  stdio: ["ignore", "inherit", "inherit"],
});
if (install.status !== 0) process.exit(install.status ?? 1);

// Replace only symlinks, so a real directory in the main checkout is never deleted
for (const path of LINKED_PATHS) {
  const source = NodePath.join(projectRoot, path);
  const target = NodePath.join(worktree, path);
  if (source === target || !NodeFS.existsSync(source)) continue;
  const existing = NodeFS.lstatSync(target, { throwIfNoEntry: false });
  if (existing && !existing.isSymbolicLink()) continue;
  if (existing) NodeFS.rmSync(target);
  NodeFS.symlinkSync(source, target);
}
