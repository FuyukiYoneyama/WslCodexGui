// Generate THIRD-PARTY-LICENSES.txt: the copyright notices and full license
// texts of every third-party component that ships inside the app.
//
//   node scripts/generate-third-party-licenses.mjs          # write the file
//   node scripts/generate-third-party-licenses.mjs --check  # fail if it is stale
//
// Apache-2.0, BSD and MPL-2.0 (among others) require the notice and license
// text to accompany binary distributions; THIRD-PARTY-NOTICES.md is only a
// summary of the 2026-07-23 license survey and does not satisfy that.
//
// Two sources, both covering only what is actually distributed:
// - Rust: `cargo about generate --format json` (settings in
//   src-tauri/about.toml: Windows target, no build/dev dependencies). Needs
//   `cargo install --locked cargo-about --features cli`.
// - npm: package-lock.json entries not marked "dev" -- the packages Vite can
//   bundle into the frontend -- with each package's own LICENSE file from
//   node_modules (so run `npm ci` first).
//
// The output is deterministic (sorted, no timestamps), so --check can tell
// whether a dependency change left it out of date.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const APP = fileURLToPath(new URL("..", import.meta.url));
const REPO = resolve(APP, "..");
const OUT = resolve(REPO, "THIRD-PARTY-LICENSES.txt");
const check = process.argv.includes("--check");

function fail(message) {
  console.error(`エラー: ${message}`);
  process.exit(2);
}

const RULE = "=".repeat(78);
const rule = "-".repeat(78);
const normalize = (text) => text.replace(/\r\n?/g, "\n").replace(/[ \t]+$/gm, "").trim();

// ---- Rust crates -----------------------------------------------------------

function rustSection() {
  // Written to a file rather than read from stdout: cargo-about refuses to
  // write to a redirected stdout when launched from PowerShell (it guards
  // against PowerShell's re-encoding).
  const jsonPath = resolve(tmpdir(), `wslcodexgui-cargo-about-${process.pid}.json`);
  try {
    execFileSync("cargo", ["about", "generate", "--format", "json", "-o", jsonPath], {
      cwd: resolve(APP, "src-tauri"),
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (e) {
    fail(`cargo about の実行に失敗しました（未インストールなら cargo install --locked cargo-about --features cli）\n${e.stderr ?? e.message}`);
  }
  const about = JSON.parse(readFileSync(jsonPath, "utf8"));
  rmSync(jsonPath, { force: true });
  // Group crates that share an identical license text, so each text appears once.
  const groups = new Map();
  for (const license of about.licenses) {
    const text = normalize(license.text);
    const key = `${license.id}\n${text}`;
    const group = groups.get(key) ?? { id: license.id, name: license.name, text, crates: new Set() };
    for (const used of license.used_by) group.crates.add(`${used.crate.name} ${used.crate.version}`);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort((a, b) => a.id.localeCompare(b.id) || a.text.localeCompare(b.text));
  const crateCount = new Set(about.licenses.flatMap((l) => l.used_by.map((u) => `${u.crate.name} ${u.crate.version}`))).size;
  const body = sorted.map((g) =>
    [rule, `${g.name} (${g.id})`, "", "Used by:", ...[...g.crates].sort().map((c) => `  ${c}`), "", g.text, ""].join("\n"),
  );
  return { count: crateCount, text: body.join("\n") };
}

// ---- npm packages ----------------------------------------------------------

// e.g. LICENSE, LICENSE.md, LICENSE-MIT, LICENSE_APACHE-2.0 (@tauri-apps/api), COPYING, NOTICE
const LICENSE_FILE = /^(licen[cs]e|copying|notice)([._-].*)?$/i;

function npmSection() {
  const lock = JSON.parse(readFileSync(resolve(APP, "package-lock.json"), "utf8"));
  const packages = Object.entries(lock.packages ?? {})
    .filter(([path, p]) => path.startsWith("node_modules/") && !p.dev)
    .map(([path, p]) => ({ path, name: path.slice(path.lastIndexOf("node_modules/") + 13), version: p.version, license: p.license }));
  const missing = [];
  const groups = new Map();
  for (const pkg of packages) {
    const dir = resolve(APP, pkg.path);
    if (!existsSync(dir)) fail(`${pkg.path} がありません。先に npm ci を実行してください`);
    const meta = JSON.parse(readFileSync(resolve(dir, "package.json"), "utf8"));
    const license = pkg.license ?? meta.license ?? "UNKNOWN";
    const files = readdirSync(dir).filter((f) => LICENSE_FILE.test(f)).sort();
    let text = files.map((f) => normalize(readFileSync(resolve(dir, f), "utf8"))).join("\n\n");
    if (!text) {
      missing.push(`${pkg.name}@${pkg.version}`);
      const author = typeof meta.author === "string" ? meta.author : meta.author?.name;
      text = `This package does not include a license file. package.json declares: ${license}` + (author ? `\nAuthor: ${author}` : "");
    }
    const key = `${license}\n${text}`;
    const group = groups.get(key) ?? { license, text, packages: new Set() };
    group.packages.add(`${pkg.name} ${pkg.version}`);
    groups.set(key, group);
  }
  const sorted = [...groups.values()].sort(
    (a, b) => a.license.localeCompare(b.license) || [...a.packages][0].localeCompare([...b.packages][0]),
  );
  const body = sorted.map((g) =>
    [rule, g.license, "", "Used by:", ...[...g.packages].sort().map((p) => `  ${p}`), "", g.text, ""].join("\n"),
  );
  return { count: packages.length, missing, text: body.join("\n") };
}

// ---- assemble --------------------------------------------------------------

const version = JSON.parse(readFileSync(resolve(APP, "package.json"), "utf8")).version;
const rust = rustSection();
const npm = npmSection();
const output = [
  RULE,
  "WSL Codex GUI - Third-party software licenses",
  RULE,
  "",
  "WSL Codex GUI itself is distributed under the MIT License (see LICENSE).",
  "It includes the third-party components listed below, each under its own",
  "license. Their copyright notices and license texts are reproduced here as",
  "those licenses require.",
  "",
  `Generated for version ${version} by app/scripts/generate-third-party-licenses.mjs.`,
  `Rust crates: ${rust.count}   npm packages: ${npm.count}`,
  "",
  RULE,
  "Part 1: Rust crates (compiled into the executable)",
  RULE,
  "",
  rust.text,
  RULE,
  "Part 2: npm packages (bundled into the user interface)",
  RULE,
  "",
  npm.text,
].join("\n").replace(/\n{3,}/g, "\n\n") + "\n";

if (check) {
  const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
  // The version line changes on every bump without any dependency change.
  const strip = (s) => s.replace(/^Generated for version .*$/m, "");
  if (strip(current) !== strip(output)) {
    console.error("THIRD-PARTY-LICENSES.txt が依存関係と一致しません。node scripts/generate-third-party-licenses.mjs で再生成してください");
    process.exit(1);
  }
  console.log("THIRD-PARTY-LICENSES.txt: 最新です");
} else {
  writeFileSync(OUT, output);
  console.log(`THIRD-PARTY-LICENSES.txt を書き出しました（Rust ${rust.count}件・npm ${npm.count}件、${(output.length / 1024).toFixed(0)} KB）`);
}
if (npm.missing.length) {
  console.warn(`ライセンス文書を含まないnpmパッケージ（package.jsonの宣言のみ記載）: ${npm.missing.join(", ")}`);
}
