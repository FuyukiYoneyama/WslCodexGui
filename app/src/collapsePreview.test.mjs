import assert from "node:assert/strict";
import test from "node:test";
import { collapsePreview } from "./collapsePreview.ts";

test("uses the first non-empty line", () => {
  assert.equal(collapsePreview("最初の行\n二行目\n三行目"), "最初の行");
});

test("skips leading blank lines", () => {
  assert.equal(collapsePreview("\n\n  \n本文です"), "本文です");
});

test("trims surrounding whitespace", () => {
  assert.equal(collapsePreview("   本文です   \n次"), "本文です");
});

test("truncates a long line with an ellipsis", () => {
  const preview = collapsePreview("あ".repeat(200));
  assert.equal(preview.length, 61);
  assert.ok(preview.endsWith("…"));
});

test("a line exactly at the limit is not truncated", () => {
  const line = "あ".repeat(60);
  assert.equal(collapsePreview(line), line);
});

test("empty input still yields something to show", () => {
  assert.equal(collapsePreview(""), "(空のメッセージ)");
  assert.equal(collapsePreview("\n \n"), "(空のメッセージ)");
});

test("the real restatement that prompted this collapses to a readable line", () => {
  const message =
    "了解しました。Mesen2 の入力デバイス警告で、Mapper 4 の問題ではありません。\n\n" +
    "検査 ROM は自動実行なので、警告は「OK」で閉じて大丈夫です。以後は `--noinput` を付けて実行します。";
  assert.equal(
    collapsePreview(message),
    "了解しました。Mesen2 の入力デバイス警告で、Mapper 4 の問題ではありません。"
  );
});
