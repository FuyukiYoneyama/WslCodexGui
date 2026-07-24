// The product version is duplicated across package.json, Cargo.toml, and
// tauri.conf.json (no single source of truth exists in a Tauri 2 project
// without extra tooling this project doesn't otherwise need). Manual edits
// to only one or two of them silently drift apart -- catch that loudly here
// instead of shipping a build where the footer, Cargo package, and installer
// metadata disagree about what version it even is.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function readJsonVersion(relPath) {
  const raw = readFileSync(ROOT + relPath, "utf8");
  return JSON.parse(raw).version;
}

function readCargoTomlVersion(relPath) {
  const raw = readFileSync(ROOT + relPath, "utf8");
  const match = /^version\s*=\s*"([^"]+)"/m.exec(raw);
  return match ? match[1] : null;
}

const versions = {
  "package.json": readJsonVersion("package.json"),
  "src-tauri/tauri.conf.json": readJsonVersion("src-tauri/tauri.conf.json"),
  "src-tauri/Cargo.toml": readCargoTomlVersion("src-tauri/Cargo.toml"),
};

const distinct = new Set(Object.values(versions));
if (distinct.size > 1) {
  console.error("Version mismatch across project files:");
  for (const [file, v] of Object.entries(versions)) console.error(`  ${file}: ${v}`);
  console.error("\nBump all three to the same value (see 残項目.md's versioning policy).");
  process.exit(1);
}
