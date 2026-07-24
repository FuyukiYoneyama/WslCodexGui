// window.confirm()/alert()/prompt() do not behave as synchronous blocking
// calls in this Tauri (wry/WebView2) app -- they resolve immediately without
// ever showing anything, so `if (!window.confirm(...))` never short-circuits
// (see docs/仕様書.md 7.3, tauri-apps/tauri#12576, upstream unfixed as of
// 2026-07-24). Use the React-state-driven modal pattern instead (see
// pendingThreadId/pendingPolicyReopen/pendingArchive in App.tsx). This script
// fails the build loudly instead of letting the silent no-op slip back in.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SRC_DIR = fileURLToPath(new URL("../src", import.meta.url));
const PATTERN = /\b(window\.)?(confirm|alert|prompt)\s*\(/;
const violations = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      walk(full);
    } else if (/\.(ts|tsx)$/.test(entry)) {
      const lines = readFileSync(full, "utf8").split("\n");
      lines.forEach((line, i) => {
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*")) return; // comments explaining this restriction don't count
        if (PATTERN.test(line)) violations.push(`${full}:${i + 1}: ${trimmed}`);
      });
    }
  }
}

walk(SRC_DIR);

if (violations.length > 0) {
  console.error(
    "window.confirm()/alert()/prompt() do not work in this app (see comment at top of this script). Found:\n"
  );
  for (const v of violations) console.error("  " + v);
  console.error("\nUse a React-state-driven modal instead (see pendingThreadId in App.tsx).");
  process.exit(1);
}
