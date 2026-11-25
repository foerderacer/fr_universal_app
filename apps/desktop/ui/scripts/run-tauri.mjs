import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const uiDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const desktopDir = path.resolve(uiDir, "..");
const binName = process.platform === "win32" ? "tauri.cmd" : "tauri";
const tauriBin = path.join(uiDir, "node_modules", ".bin", binName);

const res = spawnSync(tauriBin, process.argv.slice(2), {
  cwd: desktopDir,
  stdio: "inherit",
  shell: process.platform === "win32",
});

process.exit(res.status ?? 1);
