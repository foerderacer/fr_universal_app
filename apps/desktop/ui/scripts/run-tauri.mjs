import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.resolve(uiDir, "..");

const tauriPkgPath = require.resolve("@tauri-apps/cli/package.json");
const tauriCliEntry = path.resolve(path.dirname(tauriPkgPath), "tauri.js");

const res = spawnSync(process.execPath, [tauriCliEntry, ...process.argv.slice(2)], {
  cwd: desktopDir,
  stdio: "inherit",
  shell: false,
});

if (res.error) {
  console.error(res.error);
  process.exit(1);
}

process.exit(res.status ?? 1);
