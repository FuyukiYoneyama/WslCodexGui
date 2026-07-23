import assert from "node:assert/strict";
import test from "node:test";
import { CONFIRMED_CODEX_CLI_VERSIONS, isConfirmedCodexCliVersion, parseCodexCliVersion } from "./codexVersion.ts";

test("parses the codex-cli version out of a real userAgent string", () => {
  assert.equal(
    parseCodexCliVersion("wsl-codex-gui/0.144.6 (Ubuntu 20.4.0; x86_64) xterm-256color (wsl-codex-gui; 0.2.0)"),
    "0.144.6"
  );
});

test("returns null for a userAgent that doesn't match the expected shape", () => {
  assert.equal(parseCodexCliVersion("garbage"), null);
  assert.equal(parseCodexCliVersion(""), null);
});

test("every version this app claims to support is actually recognized as confirmed", () => {
  for (const v of CONFIRMED_CODEX_CLI_VERSIONS) {
    assert.equal(isConfirmedCodexCliVersion(v), true);
  }
});

test("an unconfirmed version is reported as such", () => {
  assert.equal(isConfirmedCodexCliVersion("0.999.0"), false);
  assert.equal(isConfirmedCodexCliVersion("0.100.0"), false);
});
