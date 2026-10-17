// Bump the product version in every file that duplicates it (see
// check-version-sync.mjs for why there are five).
//
//   node scripts/bump-version.mjs patch     # 0.5.50 -> 0.5.51
//   node scripts/bump-version.mjs 0.6.0     # explicit version
//
// Replaces by content (the current version string in its known position),
// not by line number -- the old procedure was `sed -i '52s/...'` per file,
// which silently did nothing whenever a file shifted. Finishes by running
// check-version-sync.mjs so a miss can't go unnoticed.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(2);
}

const current = JSON.parse(readFileSync(ROOT + "package.json", "utf8")).version;
const arg = process.argv[2];
if (!arg) fail("新しいバージョン（x.y.z）か patch を指定してください");
let next = arg;
if (arg === "patch") {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(current);
  if (!m) fail(`現在のバージョンを解釈できません: ${current}`);
  next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`;
}
if (!/^\d+\.\d+\.\d+$/.test(next)) fail(`x.y.z 形式ではありません: ${next}`);
if (next === current) fail(`現在と同じバージョンです: ${current}`);

// Replaces the first `count` occurrences of `pattern` (which must contain the
// current version) and insists exactly that many were found.
function replaceIn(relPath, pattern, replacement, count) {
  const text = readFileSync(ROOT + relPath, "utf8");
  let found = 0;
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const updated = text.replace(new RegExp(pattern.source, flags), (...m) => {
    found += 1;
    return found <= count ? replacement(...m) : m[0];
  });
  if (found < count) fail(`${relPath}: バージョン ${current} の記載が${count}箇所見つかりません（${found}箇所）`);
  writeFileSync(ROOT + relPath, updated);
  console.log(`  ${relPath}: ${count}箇所`);
}

const esc = current.replaceAll(".", "\\.");
console.log(`バージョン ${current} → ${next}`);
// package.json / tauri.conf.json: the top-level "version" is the first one.
replaceIn("package.json", new RegExp(`("version":\\s*")${esc}(")`), (_, a, b) => `${a}${next}${b}`, 1);
replaceIn("src-tauri/tauri.conf.json", new RegExp(`("version":\\s*")${esc}(")`), (_, a, b) => `${a}${next}${b}`, 1);
// package-lock.json: the root "version" and packages[""].version are the
// first two (npm writes the root entry before any dependency).
replaceIn("package-lock.json", new RegExp(`("version":\\s*")${esc}(")`), (_, a, b) => `${a}${next}${b}`, 2);
// Cargo.toml: [package] comes first, so its version line is the first one.
replaceIn("src-tauri/Cargo.toml", new RegExp(`(^version\\s*=\\s*")${esc}(")`, "m"), (_, a, b) => `${a}${next}${b}`, 1);
// Cargo.lock: only the entry for this crate ("app").
replaceIn(
  "src-tauri/Cargo.lock",
  new RegExp(`(\\[\\[package\\]\\]\\r?\\nname\\s*=\\s*"app"\\r?\\nversion\\s*=\\s*")${esc}(")`),
  (_, a, b) => `${a}${next}${b}`,
  1,
);

const check = spawnSync(process.execPath, [ROOT + "scripts/check-version-sync.mjs"], { encoding: "utf8" });
process.stdout.write(check.stdout ?? "");
process.stderr.write(check.stderr ?? "");
if (check.status !== 0) fail("check-version-sync.mjs が不一致を検出しました（上の出力を参照）");
console.log("整合チェック（check-version-sync.mjs）: OK");
