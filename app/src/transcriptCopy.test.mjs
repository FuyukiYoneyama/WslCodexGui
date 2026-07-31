import assert from "node:assert/strict";
import test from "node:test";
import { transcriptToText } from "./transcriptCopy.ts";

test("user and agent messages are labelled and separated by a blank line", () => {
  const text = transcriptToText([
    { item: { type: "userMessage", id: "u1", content: [{ type: "text", text: "こんにちは" }] } },
    { item: { type: "agentMessage", id: "a1", text: "やあ" } },
  ]);
  assert.equal(text, "## ユーザー\nこんにちは\n\n## Codex\nやあ");
});

test("a still-streaming agent message copies what is on screen", () => {
  const text = transcriptToText([{ item: { type: "agentMessage", id: "a1", text: "" }, streamingText: "途中まで" }]);
  assert.equal(text, "## Codex\n途中まで");
});

test("reasoning, command output and file changes are included", () => {
  const text = transcriptToText([
    { item: { type: "reasoning", id: "r1", summary: ["まず調べる"], content: [] } },
    {
      item: {
        type: "commandExecution",
        id: "c1",
        command: "ls",
        cwd: "/tmp",
        status: "completed",
        aggregatedOutput: "a.txt",
        exitCode: 0,
      },
    },
    { item: { type: "fileChange", id: "f1", status: "completed", changes: [{ path: "src/App.tsx" }] } },
  ]);
  assert.equal(
    text,
    "## 思考\nまず調べる\n\n## コマンド\n$ ls\na.txt\nexit 0\n\n## ファイル変更（completed）\n- src/App.tsx",
  );
});

test("empty messages and unknown item kinds are skipped", () => {
  assert.equal(transcriptToText([{ item: { type: "agentMessage", id: "a1", text: "" } }]), "");
  assert.equal(transcriptToText([{ item: { type: "somethingNew", id: "x1" } }]), "");
  assert.equal(transcriptToText([]), "");
});
