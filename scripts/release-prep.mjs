#!/usr/bin/env node
/**
 * Release preparation helper for FR Universal App.
 * Verifies clean `main` branch, reads the Cargo workspace version, and prints
 * the exact tagging & draft-publishing checklist.
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cargoToml = fs.readFileSync(path.join(root, "Cargo.toml"), "utf8");
const match = cargoToml.match(/^version\s*=\s*"([^"]+)"/m);
if (!match) {
  console.error("Could not find workspace version in Cargo.toml");
  process.exit(1);
}
const version = match[1];
const uiPkg = JSON.parse(
  fs.readFileSync(path.join(root, "apps/desktop/ui/package.json"), "utf8"),
);
const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: root })
  .toString()
  .trim();
const status = execSync("git status --porcelain", { cwd: root })
  .toString()
  .trim();

console.log(`Cargo version     : ${version}`);
console.log(`UI package.json   : ${uiPkg.version}`);
console.log(`Current branch    : ${branch}`);
console.log(`Working tree      : ${status ? "DIRTY" : "clean"}`);

if (uiPkg.version !== version) {
  console.error(
    `\nVersion mismatch: Cargo.toml (${version}) != apps/desktop/ui/package.json (${uiPkg.version}).`,
  );
  process.exit(1);
}

if (branch !== "main") {
  console.error("\nSwitch to main before cutting a release tag.");
  process.exit(1);
}
if (status) {
  console.error("\nCommit or stash all changes before cutting a release tag.");
  process.exit(1);
}

const tag = `v${version}`;
console.log("\nChecklist before pushing the tag:");
console.log("  1. Confirm Cargo.toml version and apps/desktop/ui/package.json version match.");
console.log("  2. Confirm GitHub secrets/vars are paired: TAURI_SIGNING_PRIVATE_KEY + FR_UPDATER_PUBKEY.");
console.log("  3. Run verification gates (cargo fmt/clippy/test + npm typecheck/lint/build).");
console.log(`  4. Create & push tag:\n       git tag -a ${tag} -m "Release ${tag}"\n       git push origin ${tag}`);
console.log("  5. Wait for Release workflow + Verify & Merge Updater Manifest job to finish.");
console.log("  6. Review the Draft GitHub Release notes, then click Publish so latest.json goes live.");
