import assert from "node:assert/strict";
import test from "node:test";
import { formatLinkAddress, splitLineSuffix } from "./linkTarget.ts";

test("a plain path is left alone", () => {
  assert.deepEqual(splitLineSuffix("src/App.tsx"), { path: "src/App.tsx", line: null });
  assert.deepEqual(splitLineSuffix("/home/user/notes.md"), { path: "/home/user/notes.md", line: null });
});

test("codex's path:line and path:line:col suffixes are split off", () => {
  assert.deepEqual(splitLineSuffix("src/App.tsx:2827"), { path: "src/App.tsx", line: 2827 });
  assert.deepEqual(splitLineSuffix("src/App.tsx:2827:14"), { path: "src/App.tsx", line: 2827 });
});

test("the GitHub #L form is split off too, including a range", () => {
  assert.deepEqual(splitLineSuffix("src/App.tsx#L42"), { path: "src/App.tsx", line: 42 });
  assert.deepEqual(splitLineSuffix("src/App.tsx#L42-L60"), { path: "src/App.tsx", line: 42 });
});

test("a Windows path keeps its drive letter", () => {
  assert.deepEqual(splitLineSuffix("C:\\src\\App.tsx:42"), { path: "C:\\src\\App.tsx", line: 42 });
  assert.deepEqual(splitLineSuffix("C:\\src\\App.tsx"), { path: "C:\\src\\App.tsx", line: null });
});

test("a colon with no filename in front of it is not a line number", () => {
  assert.deepEqual(splitLineSuffix(":42"), { path: ":42", line: null });
  assert.deepEqual(splitLineSuffix("C:42"), { path: "C:42", line: null });
});

test("a trailing colon without digits is part of the name", () => {
  assert.deepEqual(splitLineSuffix("src/weird:"), { path: "src/weird:", line: null });
});

test("the copied address puts the line number back", () => {
  assert.equal(formatLinkAddress("/home/user/src/App.tsx", 42), "/home/user/src/App.tsx:42");
  assert.equal(formatLinkAddress("/home/user/src/App.tsx", null), "/home/user/src/App.tsx");
});
