import assert from "node:assert/strict";
import test from "node:test";
import { PROJECT_SANDBOX, gitWritableRootsConfig } from "./sandboxConfig.ts";

test("projects always run under workspace-write", () => {
  assert.equal(PROJECT_SANDBOX, "workspace-write");
});

test("writable_roots lists the project itself and its .git", () => {
  assert.deepEqual(gitWritableRootsConfig("/home/user/proj"), {
    "sandbox_workspace_write.writable_roots": ["/home/user/proj", "/home/user/proj/.git"],
  });
});

test("a trailing slash on cwd does not produce a doubled slash", () => {
  assert.deepEqual(gitWritableRootsConfig("/home/user/proj/"), {
    "sandbox_workspace_write.writable_roots": ["/home/user/proj", "/home/user/proj/.git"],
  });
});
